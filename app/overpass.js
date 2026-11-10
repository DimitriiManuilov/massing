/* ============================================================
   Загрузка и разбор данных OpenStreetMap через Overpass API.
   ============================================================ */

import {
  heightOf, minHeightOf, levelsOf, ensureClosed, dedupe,
  ringArea, stitchRings, pointInRing, centroid
} from './geo.js';

/**
 * Зеркала Overpass в порядке скорости ответа по замерам августа 2026.
 * Публичные серверы регулярно уходят в перегрузку и отвечают 504,
 * поэтому список важнее одного «главного» адреса.
 */
const ENDPOINTS = [
  { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', name: 'maps.mail.ru' },
  { url: 'https://overpass.osm.ch/api/interpreter', name: 'overpass.osm.ch' },
  { url: 'https://overpass-api.de/api/interpreter', name: 'overpass-api.de' },
  { url: 'https://overpass.kumi.systems/api/interpreter', name: 'kumi.systems' }
];

const query = (b) => `
[out:json][timeout:120][bbox:${b.south},${b.west},${b.north},${b.east}];
(
  way["building"];
  relation["building"]["type"="multipolygon"];
  way["building:part"];
  way["highway"]["area"!="yes"]["highway"!~"^(proposed|construction|elevator|corridor|platform|bus_stop|street_lamp)$"];
  way["natural"="water"];
  relation["natural"="water"]["type"="multipolygon"];
  way["waterway"="riverbank"];
  way["landuse"~"^(reservoir|basin)$"];
  way["leisure"~"^(park|garden|pitch|playground|dog_park)$"];
  way["amenity"="parking"];
  way["highway"~"^(pedestrian|footway)$"]["area"="yes"];
  way["man_made"="pier"];
  relation["leisure"~"^(park|garden)$"]["type"="multipolygon"];
  way["landuse"~"^(grass|forest|meadow|village_green|recreation_ground|cemetery|allotments|orchard)$"];
  way["natural"~"^(wood|scrub|grassland|heath)$"];
  node["natural"="tree"];
  way["natural"="tree_row"];
  node["highway"="street_lamp"];
  way["barrier"~"^(fence|wall|hedge|retaining_wall)$"];
);
out geom;`;

/**
 * Обходит зеркала по очереди, не задерживаясь на молчащих.
 *
 * Опробованная параллельная гонка оказалась хуже: Overpass отвечает
 * на одновременные запросы с одного адреса ошибкой 406, так что
 * последовательный обход с коротким сроком ожидания и быстрым
 * переходом к следующему зеркалу выигрывает и по времени, и по
 * отношению к чужому бесплатному сервису.
 */
export async function fetchOSM(bbox, onProgress = () => {}) {
  const body = 'data=' + encodeURIComponent(query(bbox));
  const TIMEOUT = 35000;
  const errors = [];

  for (let i = 0; i < ENDPOINTS.length; i++) {
    const { url, name } = ENDPOINTS[i];
    onProgress(i === 0
      ? `Запрос к OpenStreetMap · ${name}…`
      : `${name} — зеркало ${i + 1} из ${ENDPOINTS.length}…`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: ctrl.signal
      });
      if (!res.ok) {
        // 429 и 504 значат «занят», а не «данных нет» — идём дальше.
        throw new Error(res.status === 429 ? 'ограничил частоту запросов'
                      : res.status === 504 ? 'перегружен'
                      : `HTTP ${res.status}`);
      }
      const json = await res.json();
      if (!json.elements) throw new Error('пустой ответ');
      return json.elements;
    } catch (e) {
      errors.push(`${name}: ${e.name === 'AbortError' ? `молчал ${TIMEOUT / 1000} с` : e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Данные OSM недоступны — все зеркала заняты. ' + errors.join('; ') +
                  '. Попробуйте через минуту: публичные серверы Overpass регулярно перегружены.');
}

/* ---------- классификация ---------- */

// Ширина проезжей части в метрах по классу дороги.
const ROAD_W = {
  motorway: 22, motorway_link: 9, trunk: 20, trunk_link: 9,
  primary: 16, primary_link: 8, secondary: 13, secondary_link: 7,
  tertiary: 11, tertiary_link: 6, unclassified: 8, residential: 8,
  living_street: 7, service: 5, pedestrian: 7, track: 4,
  footway: 2.4, path: 2, cycleway: 2.6, steps: 2, bridleway: 2.4
};

const isGreen = t =>
  /^(park|garden|dog_park)$/.test(t.leisure || '') ||
  /^(grass|forest|meadow|village_green|recreation_ground|cemetery|allotments|orchard)$/.test(t.landuse || '') ||
  /^(wood|scrub|grassland|heath)$/.test(t.natural || '');

/**
 * Твёрдые покрытия двора: парковки, спортплощадки, детские площадки,
 * пешеходные площади.
 *
 * Раньше площадки шли по зелени и красились газоном, а парковок не было
 * вовсе — двор выходил ровным серым пятном между домами. Между тем
 * именно двор занимает половину кадра, и его состав говорит о квартале
 * не меньше, чем этажность.
 */
const isPaved = t =>
  t.amenity === 'parking' ||
  /^(pitch|playground)$/.test(t.leisure || '') ||
  t.man_made === 'pier' ||
  (t.area === 'yes' && /^(pedestrian|footway)$/.test(t.highway || ''));

const isWater = t =>
  t.natural === 'water' || t.waterway === 'riverbank' ||
  /^(reservoir|basin)$/.test(t.landuse || '');

/* ---------- разбор ---------- */

export function parseOSM(elements, project) {
  const buildings = [], roads = [], water = [], green = [], paved = [], parts = [];
  const trees = [], lamps = [], fences = [];

  const ringOf = (geometry) =>
    dedupe(ensureClosed(geometry.map(p => project(p.lon, p.lat))));

  for (const el of elements) {
    const t = el.tags || {};

    /* --- точечные объекты: деревья и фонари --- */
    if (el.type === 'node') {
      if (t.natural === 'tree') trees.push(project(el.lon, el.lat));
      else if (t.highway === 'street_lamp') lamps.push(project(el.lon, el.lat));
      continue;
    }

    // Аллея: сажаем деревья по линии с шагом около восьми метров.
    if (el.type === 'way' && t.natural === 'tree_row' && el.geometry) {
      const pts = el.geometry.map(p => project(p.lon, p.lat));
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.round(len / 8));
        for (let k = 0; k < n; k++) {
          const f = k / n;
          trees.push([ax + (bx - ax) * f, az + (bz - az) * f]);
        }
      }
      continue;
    }

    // Ограды и живые изгороди: тонкие стенки вдоль линии. Мелочь, но
    // именно она отделяет двор от улицы и задаёт зернистость квартала.
    if (el.type === 'way' && t.barrier && el.geometry && el.geometry.length > 1) {
      fences.push({
        pts: dedupe(el.geometry.map(p => project(p.lon, p.lat))),
        h: t.barrier === 'hedge' ? 1.6 : t.barrier === 'retaining_wall' ? 1.2 : 1.9,
        w: t.barrier === 'hedge' ? 0.8 : 0.25
      });
      continue;
    }

    /* --- линии УДС --- */
    // Пешеходная площадь — это полигон, а не линия: её ловим ниже.
    if (el.type === 'way' && t.highway && t.area !== 'yes') {
      if (!el.geometry || el.geometry.length < 2) continue;
      const layer = parseInt(t.layer || '0', 10) || 0;
      roads.push({
        pts: dedupe(el.geometry.map(p => project(p.lon, p.lat))),
        w: ROAD_W[t.highway] ?? 6,
        cls: t.highway,
        // Мост поднимается над руслом; уровень берём из layer, а при
        // его отсутствии — один пролёт. Без этого путепроводы лежали
        // прямо на воде.
        bridge: t.bridge && t.bridge !== 'no' ? Math.max(1, layer) * 5.5 + 1.5 : 0,
        // тротуары и дорожки — отдельным, более светлым тоном
        soft: /^(footway|path|cycleway|steps|pedestrian|bridleway|track)$/.test(t.highway)
      });
      continue;
    }

    /* --- полигональные объекты --- */
    let rings = null;

    if (el.type === 'way') {
      if (!el.geometry || el.geometry.length < 4) continue;
      const r = ringOf(el.geometry);
      if (r.length < 4) continue;
      rings = [r];
    } else if (el.type === 'relation') {
      if (!el.members) continue;
      const outerSegs = [], innerSegs = [];
      for (const m of el.members) {
        if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
        const seg = m.geometry.map(p => project(p.lon, p.lat));
        (m.role === 'inner' ? innerSegs : outerSegs).push(seg);
      }
      const outers = stitchRings(outerSegs).map(dedupe);
      const inners = stitchRings(innerSegs).map(dedupe);
      if (!outers.length) continue;

      // самое большое внешнее кольцо + все дырки, попадающие внутрь него
      outers.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
      const outer = outers[0];
      rings = [outer, ...inners.filter(h => h.length > 3 && pointInRing(h[0], outer))];
    } else continue;

    if (!rings) continue;
    const area = Math.abs(ringArea(rings[0]));

    if (t['building:part'] && !t.building) {
      if (area < 4) continue;
      parts.push(makeBuilding(el, t, rings, area));
    } else if (t.building) {
      if (area < 4) continue;                    // мусор и точечные объекты
      buildings.push(makeBuilding(el, t, rings, area));
    } else if (isWater(t)) {
      water.push({ rings, area });
    } else if (isPaved(t)) {
      paved.push({ rings, area, kind: t.amenity || t.leisure || t.highway || t.man_made });
    } else if (isGreen(t)) {
      green.push({ rings, area, kind: t.leisure || t.landuse || t.natural });
    }
  }

  /* --- building:part замещает контур родительского здания --- */
  // Схема Simple 3D Buildings: если внутри контура здания есть части,
  // рисуем части, а сам контур убираем — иначе объёмы задвоятся.
  if (parts.length) {
    for (const p of parts) {
      const c = centroid(p.rings[0]);
      for (const b of buildings) {
        if (!b.hasParts && pointInRing(c, b.rings[0])) { b.hasParts = true; break; }
      }
    }
    for (const p of parts) buildings.push(p);
  }

  return {
    buildings: buildings.filter(b => !b.hasParts),
    roads, water, green, paved, trees, lamps, fences
  };
}

function makeBuilding(el, tags, rings, area) {
  const { h, estimated, src } = heightOf(tags);
  return {
    id: `${el.type[0]}${el.id}`,
    tags, rings, area,
    h: Math.max(h, 1.5),
    minH: minHeightOf(tags),
    levels: levelsOf(tags),
    estimated, src,
    hasParts: false
  };
}
