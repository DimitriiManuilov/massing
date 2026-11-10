/* ============================================================
   Проекция и разбор геометрии OSM.

   Работаем в локальной метрической системе с началом в центре
   выбранного прямоугольника: для участка в 1–2 км искажение
   равнопромежуточной проекции — доли процента, что заведомо
   меньше точности самих данных OSM.

   Оси three.js: X — восток, Z — юг (то есть север = −Z), Y — вверх.
   ============================================================ */

const R_LAT = 111320;            // м на градус широты
const latScale = lat => 111320 * Math.cos(lat * Math.PI / 180);

export function makeProjection(bbox) {
  const lat0 = (bbox.south + bbox.north) / 2;
  const lon0 = (bbox.west + bbox.east) / 2;
  const kx = latScale(lat0);

  const project = (lon, lat) => [ (lon - lon0) * kx, -(lat - lat0) * R_LAT ];
  project.lat0 = lat0;
  project.lon0 = lon0;
  project.unproject = (x, z) => [ lon0 + x / kx, lat0 - z / R_LAT ];
  project.width  = (bbox.east  - bbox.west ) * kx;      // м, восток–запад
  project.height = (bbox.north - bbox.south) * R_LAT;   // м, север–юг
  return project;
}

export function bboxAreaKm2(bbox) {
  const lat0 = (bbox.south + bbox.north) / 2;
  return ((bbox.east - bbox.west) * latScale(lat0) *
          (bbox.north - bbox.south) * R_LAT) / 1e6;
}

/** Описанный вокруг круга прямоугольник — им запрашиваем OSM. */
export function circleBBox(lat, lon, radius) {
  const dLat = radius / R_LAT;
  const dLon = radius / latScale(lat);
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

/**
 * Окно обрезки как выпуклый многоугольник в локальных метрах.
 * Круг аппроксимируем 64 сторонами: на глаз это уже окружность,
 * а обрезка выпуклым окном работает по тому же алгоритму, что и
 * по прямоугольнику.
 */
export function circleWindow(radius, segments = 64) {
  const win = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    win.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return win;
}

/* ---------- разбор высот ---------- */

// Типовая высота этажа. 3.0 м — усреднение по массовой застройке
// XX века: панельные 2.8, довоенные и современные 3.2–3.5.
const FLOOR = 3.0;

const parseLen = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  let m = s.match(/^(-?[\d.,]+)\s*(m|м|meters?)?$/i);
  if (m) { const n = parseFloat(m[1].replace(',', '.')); return isFinite(n) ? n : null; }
  m = s.match(/^(\d+)\s*'\s*(?:(\d+)\s*")?$/);            // 40'6"
  if (m) return (+m[1] * 12 + (+(m[2] || 0))) * 0.0254;
  const n = parseFloat(s.replace(',', '.'));
  return isFinite(n) ? n : null;
};

// Оценка высоты по назначению здания, когда в OSM нет ни height,
// ни building:levels. Такие объёмы помечаются estimated = true.
const FALLBACK = {
  garage: 2.6, garages: 3.0, shed: 2.8, hut: 2.8, roof: 3.0, carport: 2.6,
  service: 3.2, kiosk: 3.0, greenhouse: 3.5, container: 2.6,
  house: 7.0, detached: 7.0, bungalow: 4.0, cabin: 3.5, farm: 6.0,
  terrace: 9.0, semidetached_house: 7.0, dormitory: 15.0,
  retail: 6.5, supermarket: 7.0, commercial: 12.0, office: 18.0,
  industrial: 8.5, warehouse: 9.0, hangar: 10.0,
  school: 12.0, university: 18.0, hospital: 21.0, kindergarten: 8.0,
  church: 18.0, chapel: 9.0, cathedral: 30.0, mosque: 16.0,
  train_station: 12.0, transportation: 9.0, parking: 12.0,
  apartments: 15.0, residential: 15.0, hotel: 21.0, civic: 15.0,
  public: 15.0, government: 18.0, sports_hall: 10.0, stadium: 18.0,
  construction: 12.0, yes: 12.0
};

export function heightOf(tags) {
  const h = parseLen(tags.height) ?? parseLen(tags['building:height']);
  if (h != null && h > 0.5) return { h, estimated: false, src: 'height' };

  const lv = parseFloat(String(tags['building:levels'] ?? '').replace(',', '.'));
  if (isFinite(lv) && lv > 0) {
    // + парапет/кровля: без этого дома выглядят приземистыми
    return { h: lv * FLOOR + 1.2, estimated: false, src: 'levels' };
  }

  const est = parseLen(tags.est_height);
  if (est != null && est > 0.5) return { h: est, estimated: true, src: 'est' };

  const t = tags.building === 'yes' ? (tags.amenity || tags.shop ? 'retail' : 'yes')
                                    : tags.building;
  return { h: FALLBACK[t] ?? FALLBACK.yes, estimated: true, src: 'fallback' };
}

// Нижняя отметка: min_height / building:min_level (арки, надстройки,
// building:part над стилобатом).
export function minHeightOf(tags) {
  const mh = parseLen(tags.min_height);
  if (mh != null && mh > 0) return mh;
  const ml = parseFloat(String(tags['building:min_level'] ?? '').replace(',', '.'));
  if (isFinite(ml) && ml > 0) return ml * FLOOR;
  return 0;
}

export function levelsOf(tags) {
  const lv = parseFloat(String(tags['building:levels'] ?? '').replace(',', '.'));
  return isFinite(lv) && lv > 0 ? lv : null;
}

/* ---------- кольца и полигоны ---------- */

// Площадь кольца со знаком (формула шнурков). Знак задаёт направление обхода.
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

export function ensureClosed(ring) {
  if (ring.length < 3) return ring;
  const f = ring[0], l = ring[ring.length - 1];
  if (f[0] !== l[0] || f[1] !== l[1]) return [...ring, f];
  return ring;
}

// Убирает дубли подряд идущих точек — иначе триангулятор даёт мусор.
export function dedupe(ring) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(q[1] - p[1]) > 1e-6) out.push(p);
  }
  return out;
}

// Собирает замкнутые кольца из разрозненных way-сегментов мультиполигона.
// Overpass отдаёт члены relation в произвольном порядке и направлении.
export function stitchRings(segments) {
  const rings = [];
  const open = segments.map(s => s.slice()).filter(s => s.length > 1);
  const key = p => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

  while (open.length) {
    let cur = open.pop();
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 2000) {
      const tail = key(cur[cur.length - 1]);
      let found = -1, rev = false;
      for (let i = 0; i < open.length; i++) {
        if (key(open[i][0]) === tail) { found = i; rev = false; break; }
        if (key(open[i][open[i].length - 1]) === tail) { found = i; rev = true; break; }
      }
      if (found < 0) break;                      // разорванное кольцо — бросаем
      const seg = open.splice(found, 1)[0];
      const add = rev ? seg.slice().reverse() : seg;
      cur = cur.concat(add.slice(1));
    }
    if (cur.length > 3 && key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}

// Дырка ли кольцо: тест «точка внутри полигона» по лучу.
export function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(ring) {
  let x = 0, y = 0, a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const cr = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    a += cr; x += (ring[i][0] + ring[i + 1][0]) * cr; y += (ring[i][1] + ring[i + 1][1]) * cr;
  }
  if (Math.abs(a) < 1e-9) return ring[0].slice();
  return [x / (3 * a), y / (3 * a)];
}
