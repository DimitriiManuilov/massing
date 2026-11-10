/* ============================================================
   Возраст застройки и морфотипы московских домов.

   Данные: how-old-is-this.house (ODbL), версия 15.10.2022 —
   124 219 зданий Москвы с годом постройки. Хранятся компактно:
   долгота, широта (по 4 байта) и год (2 байта) на здание, всего
   1.2 МБ вместо стомегабайтного GeoPackage.

   Зачем: год постройки в Москве почти однозначно задаёт тип дома,
   а тип — пропорции, которые видно даже в сером массинге. Сталинка
   выше хрущёвки не потому, что этажей больше, а потому что этаж
   3.3 м против 2.6. Дореволюционный дом стоит под скатной кровлей,
   панельный — под плоской с парапетом. Эти признаки и строятся.
   ============================================================ */

const URL_BIN = '../data/moscow_ages.bin';
const CELL = 0.004;                 // ячейка сетки поиска, ≈250 м по широте

let index = null;                   // Map: ключ ячейки → массив записей
let bbox = null;

/** Загружает индекс один раз за сеанс. */
export async function loadAges(baseUrl) {
  if (index) return true;
  try {
    const res = await fetch(new URL(URL_BIN, baseUrl));
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    const view = new DataView(buf);
    if (String.fromCharCode(view.getUint8(0), view.getUint8(1),
                            view.getUint8(2), view.getUint8(3)) !== 'MAGE') return false;

    const n = view.getUint32(4, true);
    index = new Map();
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;

    for (let i = 0; i < n; i++) {
      const o = 8 + i * 10;
      const lon = view.getFloat32(o, true);
      const lat = view.getFloat32(o + 4, true);
      const year = view.getUint16(o + 8, true);
      if (lon < west) west = lon; if (lon > east) east = lon;
      if (lat < south) south = lat; if (lat > north) north = lat;

      const key = cellKey(lon, lat);
      const bucket = index.get(key);
      if (bucket) bucket.push(lon, lat, year);
      else index.set(key, [lon, lat, year]);
    }
    bbox = { west, south, east, north };
    return true;
  } catch {
    index = null;
    return false;
  }
}

const cellKey = (lon, lat) =>
  Math.floor(lon / CELL) * 100000 + Math.floor(lat / CELL);

export const agesCover = (lat, lon) =>
  !!bbox && lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;

/**
 * Год постройки для точки. Ищем ближайшую запись в соседних ячейках:
 * центроид пятна OSM и центр записи в датасете не совпадают, потому
 * что обводились независимо, но расходятся редко больше чем на десяток
 * метров.
 */
export function yearAt(lat, lon, maxMetres = 30) {
  if (!index) return 0;
  const mPerLon = 111320 * Math.cos(lat * Math.PI / 180);
  let best = 0, bestD = Infinity;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = index.get(cellKey(lon + dx * CELL, lat + dy * CELL));
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i += 3) {
        const ex = (bucket[i] - lon) * mPerLon;
        const ey = (bucket[i + 1] - lat) * 111320;
        const d = ex * ex + ey * ey;
        if (d < bestD) { bestD = d; best = bucket[i + 2]; }
      }
    }
  }
  return bestD <= maxMetres * maxMetres ? best : 0;
}

/* ============================================================
   Морфотипы
   ============================================================ */

/**
 * Тип дома по году постройки.
 *
 * Границы взяты по перелому в строительной практике, а не по
 * круглым датам: 1955-й — постановление об излишествах, после
 * которого сталинская архитектура кончилась буквально за год;
 * 1957-й — начало серийного крупнопанельного домостроения;
 * 1991-й — конец типовых серий.
 */
export const EPOCHS = [
  { to: 1917, id: 'pre',    name: 'дореволюционная',  floor: 3.6, roof: 'gabled', cornice: 0.55, plinth: 0.5 },
  { to: 1932, id: 'avant',  name: 'конструктивизм',   floor: 3.0, roof: 'flat',   cornice: 0.15, plinth: 0.2 },
  { to: 1955, id: 'stalin', name: 'сталинская',       floor: 3.3, roof: 'gabled', cornice: 0.75, plinth: 0.7 },
  { to: 1968, id: 'khrush', name: 'хрущёвка',         floor: 2.6, roof: 'flat',   cornice: 0.1,  plinth: 0.1 },
  { to: 1991, id: 'late',   name: 'поздний СССР',     floor: 2.75, roof: 'flat',  cornice: 0.12, plinth: 0.15 },
  { to: 2010, id: 'post',   name: 'постсоветская',    floor: 3.0, roof: 'flat',   cornice: 0.2,  plinth: 0.25 },
  { to: 9999, id: 'modern', name: 'современная',      floor: 3.15, roof: 'flat',  cornice: 0.15, plinth: 0.3 }
];

export function epochOf(year) {
  if (!year) return null;
  for (const e of EPOCHS) if (year <= e.to) return e;
  return null;
}
