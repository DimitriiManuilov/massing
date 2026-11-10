/* ============================================================
   Инсоляция: сколько часов солнца получает каждая точка земли.

   Зачем это здесь. Массинг показывает, что стоит; тень на выбранный
   час показывает, куда падает в этот час. Но проектировщика
   интересует не мгновение, а норма: двор считается пригодным, если
   солнце стоит в нём не меньше двух часов подряд, а квартиру нельзя
   поставить в вечную тень. Ровно на этот вопрос отвечает суммарная
   за день картина, и её нельзя увидеть, крутя ползунок времени.

   Считается в двух измерениях, без единого луча по треугольникам.
   Застройка сводится к сетке максимальных высот; из точки шагаем в
   сторону солнца и сравниваем высоту препятствия с высотой луча над
   землёй на этом расстоянии. Для косой тени длиной в сотню метров
   этого достаточно, а стоит это доли секунды вместо десятков.
   ============================================================ */

import { sunPosition } from './sun.js';
import { terrainAt } from './terrain.js';

const CELL = 3;              // ячейка сетки высот, м
const SAMPLE = 6;            // шаг точек расчёта, м
const MAX_REACH = 400;       // дальше препятствие уже не достанет, м
const NONE = -1e6;           // «здесь ничего не стоит»

/**
 * Сетка максимальных высот застройки над уровнем земли.
 *
 * Здание кладём по габариту пятна, а не по контуру: тень считается с
 * шагом в три метра, и разница между пятном и его габаритом на этом
 * масштабе меньше самой ячейки. Зато габарит заполняется за четыре
 * арифметических действия вместо разбора многоугольника.
 */
function heightGrid(buildings, radius, terrain) {
  const n = Math.ceil((radius * 2) / CELL) + 2;
  const grid = new Float32Array(n * n);
  // Пустая ячейка — не нулевая высота, а отсутствие препятствия.
  // Отметки в сцене отсчитываются от нуля в обе стороны, и на нулевой
  // заготовке всё, что стоит ниже датума, молча отбрасывалось: под
  // Москвой это оказалась вся застройка сразу, и двор выходил
  // освещённым круглый год.
  grid.fill(NONE);
  const origin = -radius - CELL;

  for (const b of buildings) {
    const ring = b.rings[0];
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of ring) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const ground = terrain ? terrainAt(terrain, (x0 + x1) / 2, (z0 + z1) / 2) : 0;
    const top = ground + b.h;

    const i0 = Math.max(0, Math.floor((x0 - origin) / CELL));
    const i1 = Math.min(n - 1, Math.ceil((x1 - origin) / CELL));
    const j0 = Math.max(0, Math.floor((z0 - origin) / CELL));
    const j1 = Math.min(n - 1, Math.ceil((z1 - origin) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * n + i;
        if (top > grid[k]) grid[k] = top;
      }
    }
  }
  let filled = 0, top = NONE;
  for (const h of grid) if (h > NONE) { filled++; if (h > top) top = h; }
  return { grid, n, origin, filled, top };
}

/**
 * Моменты, по которым считаем.
 *
 * Шаг в двадцать минут: при часовом шаге узкий двор между двумя
 * пластинами получал ноль или два часа в зависимости от того, попал
 * ли просвет между домами в отсчёт, и картина скакала от даты к дате.
 */
function sunTrack(date, lat, lon, tz) {
  const track = [];
  const stepMin = 20;
  for (let m = 0; m < 24 * 60; m += stepMin) {
    const utc = new Date(Date.UTC(
      +date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10),
      0, m - tz * 60
    ));
    const { altitude, azimuth } = sunPosition(utc, lat, lon);
    if (altitude <= 0.02) continue;          // ниже горизонта солнца нет
    // Направление НА солнце — ровно то же, что у sunVector в sun.js:
    // x = sin(азимут), z = −cos(азимут), азимут от севера по часовой.
    // Со сдвигом на π марш уходил в противоположную сторону, то есть
    // проверял, есть ли препятствие там, куда падает тень, а не там,
    // откуда светит. Двор при этом получался освещённым всегда.
    track.push({
      alt: altitude,
      dx: Math.sin(azimuth),
      dz: -Math.cos(azimuth),
      hours: stepMin / 60
    });
  }
  return track;
}

/**
 * Карта инсоляции.
 *
 * @returns {{data:Float32Array, n:number, origin:number, step:number,
 *            maxHours:number, share2h:number}}
 *          data — часы солнца в каждой точке; share2h — доля открытой
 *          земли, набравшей норматив в два часа.
 */
export function insolation(buildings, radius, terrain, date, lat, lon, tz) {
  const { grid, n: gn, origin: gOrigin, filled } = heightGrid(buildings, radius, terrain);
  const track = sunTrack(date, lat, lon, tz);

  const n = Math.ceil((radius * 2) / SAMPLE) + 1;
  const origin = -radius;
  const data = new Float32Array(n * n);

  const heightAt = (x, z) => {
    const i = ((x - gOrigin) / CELL) | 0, j = ((z - gOrigin) / CELL) | 0;
    if (i < 0 || j < 0 || i >= gn || j >= gn) return NONE;
    return grid[j * gn + i];
  };

  let open = 0, ok = 0, maxHours = 0, minHours = Infinity, sum = 0;

  for (let j = 0; j < n; j++) {
    const z = origin + j * SAMPLE;
    for (let i = 0; i < n; i++) {
      const x = origin + i * SAMPLE;
      if (x * x + z * z > radius * radius) { data[j * n + i] = -1; continue; }

      const ground = terrain ? terrainAt(terrain, x, z) : 0;
      // Точки под зданиями из счёта исключаем: там не двор, а дом,
      // и попав в знаменатель они занижали бы долю освещённого двора.
      if (heightAt(x, z) > ground + 1.5) { data[j * n + i] = -1; continue; }

      let hours = 0;
      for (const s of track) {
        const tan = Math.tan(s.alt);
        let lit = true;
        // Шагаем к солнцу, пока луч не поднимется выше самой высокой
        // застройки: дальше загораживать уже нечему.
        for (let d = CELL; d < MAX_REACH; d += CELL) {
          const ray = ground + d * tan;
          // Порог отсчитывается от земли в этой точке, а не от нуля
          // сцены: на склоне абсолютная отметка сама по себе ничего
          // не говорит о том, высоко ли поднялся луч.
          if (ray - ground > 220) break;
          const h = heightAt(x + s.dx * d, z + s.dz * d);
          if (h > ray) { lit = false; break; }
        }
        if (lit) hours += s.hours;
      }
      data[j * n + i] = hours;
      if (hours > maxHours) maxHours = hours;
      if (hours < minHours) minHours = hours;
      sum += hours;
      open++;
      if (hours >= 2) ok++;
    }
  }

  return {
    data, n, origin, step: SAMPLE,
    // Одной доли мало: по ней не отличить «двор освещён» от «затенение
    // вообще не считается». Минимум и среднее показывают разброс.
    maxHours: +maxHours.toFixed(2),
    minHours: +(open ? minHours : 0).toFixed(2),
    meanHours: +(open ? sum / open : 0).toFixed(2),
    share2h: open ? ok / open : 0,
    open, blockers: filled
  };
}
