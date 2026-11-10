/* ============================================================
   Фоновый поток: сеть, разбор OSM, триангуляция.

   Всё тяжёлое живёт здесь, поэтому сцена продолжает вращаться,
   пока строится следующий участок. Наружу уезжают только
   типизированные массивы — без копирования.
   ============================================================ */

import { makeProjection, circleBBox, circleWindow } from './geo.js';
import { fetchOSM, parseOSM } from './overpass.js';
import { loadTerrain } from './terrain.js';
import {
  makeClip, buildBuildings, buildAreas, buildRoads, buildCore,
  buildTrees, buildCars, buildLamps, buildFences, stats
} from './build.js';
import { cacheKey, cacheGet, cachePut } from './cache.js';
import { loadAges, agesCover, yearAt, epochOf } from './epochs.js';
import { insolation } from './insolation.js';

// Разобранная застройка переживает сборку: расчёт инсоляции приходит
// отдельным запросом, и гонять ради него Overpass заново незачем.
let last = null;

/* Стадии сборки. Их видит пользователь списком на заслонке: полоса
   показывает, сколько осталось, список — чем сейчас занят участок.
   Ключи должны совпадать с STAGES в main.js. */
const say = (pct, text, stage) => postMessage({ type: 'progress', pct, text, stage });

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'build') await build(msg.site, msg.opts || {});
    else if (msg.type === 'insolation') runInsolation(msg);
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};

function runInsolation(msg) {
  if (!last) { postMessage({ type: 'insolation', empty: true }); return; }
  const t0 = performance.now();
  const map = insolation(last.buildings, last.radius, last.terrain,
                         msg.date, last.lat, last.lon, msg.tz);
  map.ms = Math.round(performance.now() - t0);
  postMessage({ type: 'insolation', map }, [map.data.buffer]);
}

async function build(site, opts) {
  const { lat, lon, radius } = site;

  // OSM запрашиваем описанным квадратом — так проще и надёжнее
  // кэшируется; лишнее по углам отсекается обрезкой по кругу.
  const bbox = circleBBox(lat, lon, radius);
  const project = makeProjection(bbox);
  const clip = makeClip(circleWindow(radius));
  const pad = radius * 1.4;

  const key = cacheKey(bbox);
  const cached = await cacheGet(bbox);      // подойдёт и любая покрывающая выборка
  let elements, fetchedAt;
  postMessage({ type: 'cache', hit: !!cached, key, ts: cached ? cached.ts : null });
  if (cached) {
    elements = cached.elements;
    fetchedAt = cached.ts;
    say(30, `Участок из кэша: ${elements.length.toLocaleString('ru')} объектов`, 'osm');
  } else {
    say(8, 'Запрос к OpenStreetMap…', 'osm');
    elements = await fetchOSM(bbox, m => say(18, m, 'osm'));
    fetchedAt = Date.now();
    say(30, `Получено ${elements.length.toLocaleString('ru')} объектов`, 'osm');
    cachePut(key, elements);            // без await: не задерживаем сборку
  }

  const terrainPromise = opts.terrain !== false
    ? loadTerrain(bbox, project, pad, m => say(36, m, 'terrain')).catch(() => null)
    : Promise.resolve(null);

  say(42, 'Разбор геометрии…', 'parse');
  const data = parseOSM(elements, project);
  if (!data.buildings.length) {
    postMessage({ type: 'empty' });
    return;
  }

  // Возраст застройки: пока только Москва — это единственный город,
  // для которого есть открытый датасет с годом по каждому дому.
  let epochs = 0;
  const agesReady = opts.epochs !== false && await loadAges(self.location.href);
  const agesHere = agesReady && agesCover(lat, lon);
  let probe = null;
  if (agesHere) {
    say(52, 'Определяем возраст застройки…', 'age');
    for (const b of data.buildings) {
      const c = centroidLatLon(b, project);
      if (!probe) probe = { lon: c[0], lat: c[1] };
      const year = yearAt(c[1], c[0]);
      if (!year) continue;
      b.year = year;
      b.epoch = epochOf(year);
      epochs++;
      // Высота этажа зависит от эпохи сильнее, чем от чего-либо ещё:
      // сталинские 3.3 м против хрущёвских 2.6 при равной этажности
      // дают разницу в треть высоты дома.
      if (b.levels && b.epoch) {
        b.h = b.levels * b.epoch.floor + (b.epoch.roof === 'gabled' ? 0.8 : 1.0);
        b.estimated = false;
        b.src = 'epoch';
      }
    }
  }

  postMessage({ type: 'ages', loaded: agesReady, covers: agesHere, matched: epochs,
                total: data.buildings.length, probe });

  const terrain = await terrainPromise;
  last = { buildings: data.buildings, radius, terrain, lat, lon };
  say(58, `Построение ${data.buildings.length.toLocaleString('ru')} объёмов…`, 'volumes');

  const buildings = buildBuildings(data.buildings, clip, terrain, radius);
  postMessage({ type: 'diag', stepped: buildings.stepped, stepCand: buildings.stepCand,
                paved: data.paved.length, green: data.green.length });
  say(76, 'Покрытия и дорожная сеть…', 'surfaces');

  // Высоты слоёв разведены с запасом: между ними должно оставаться
  // больше, чем накапливает внутренняя микроступенька полигонов.
  const green = buildAreas(data.green, clip, 0.08, terrain);
  // Твёрдые покрытия двора идут между зеленью и тротуарами: парковка
  // лежит на газоне, но под бортовым камнем проезда.
  const paved = buildAreas(data.paved, clip, 0.18, terrain);
  const water = buildAreas(data.water, clip, 0.05, terrain, true);   // горизонтальная гладь
  const roads = buildRoads(data.roads, clip, terrain);
  const core = buildCore(terrain, radius, data.water);

  say(86, 'Деревья, транспорт, освещение…', 'props');
  const trees = buildTrees(data.green, data.trees, clip, terrain, data.buildings);
  const cars = buildCars(data.roads, clip, terrain);
  const lampPosts = buildLamps(data.lamps, data.roads, clip, terrain);
  const fences = buildFences(data.fences, clip, terrain);

  say(92, 'Передача в сцену…', 'props');

  const payload = {
    type: 'done',
    buildings, core, green, paved, water,
    roadsMain: roads.main, roadsSoft: roads.soft, bridges: roads.bridges,
    trees, cars, lampPosts, fences,
    terrain,
    stats: stats(data.buildings, Math.PI * radius * radius, clip),
    counts: {
      epochs,
      roads: data.roads.length, green: data.green.length, water: data.water.length,
      paved: data.paved.length,
      trees: trees.length / 5, cars: cars.length / 5, lamps: lampPosts.length / 5
    },
    fetchedAt,
    site: { lat0: lat, lon0: lon, radius, pad, width: radius * 2, height: radius * 2 }
  };

  postMessage(payload, transferables(payload));
}

// Центр пятна обратно в градусы: датасет возраста индексирован
// по широте и долготе, а геометрия уже в локальных метрах.
function centroidLatLon(b, project) {
  const ring = b.rings[0];
  let x = 0, z = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) { x += ring[i][0]; z += ring[i][1]; }
  return project.unproject(x / n, z / n);
}

// Собираем буферы для передачи владения: копировать мегабайты
// вершин между потоками незачем.
function transferables(p) {
  const list = [];
  const add = (a) => { if (a && a.buffer && !list.includes(a.buffer)) list.push(a.buffer); };
  if (p.buildings) {
    add(p.buildings.positions); add(p.buildings.normals); add(p.buildings.colors);
    add(p.buildings.bases); add(p.buildings.delays);
  }
  if (p.core) { add(p.core.top); add(p.core.shell); }
  add(p.green); add(p.paved); add(p.water); add(p.roadsMain); add(p.roadsSoft); add(p.bridges);
  add(p.trees); add(p.cars); add(p.lampPosts); add(p.fences);
  // Рельеф намеренно НЕ передаём во владение, а копируем: он остаётся
  // нужен здесь для расчёта инсоляции. Переданный буфер в воркере
  // отцепляется, чтение из него даёт NaN — и вся застройка молча
  // переставала отбрасывать тень, а двор выходил освещённым круглый
  // год. Копия рельефа стоит сотни килобайт, ошибка стоила дороже.
  return list;
}
