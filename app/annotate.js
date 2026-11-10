/* ============================================================
   Разметка поверх модели: линии, площадки, метки, буферы и
   пометки зданий.

   Зачем это в инструменте объёмного макета. Массинг отвечает на
   вопрос «что здесь стоит», но работа архитектора начинается со
   второго вопроса — «что здесь делать». Трассу, границу участка,
   зону в трёхстах метрах от станции, дома под снос — всё это надо
   уметь показать поверх модели и посчитать: длину, площадь, сколько
   зданий попало.

   Геометрия строится в тех же локальных метрах, что и вся сцена,
   поэтому длины и площади считаются прямо по ней, без обратного
   пересчёта в градусы.
   ============================================================ */

import * as THREE from 'three';

/* ---------- измерения ---------- */

export function lineLength(pts) {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][2] - pts[i][2]);
  }
  return s;
}

/** Площадь замкнутого контура по формуле шнурков. */
export function ringArea(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a[0] * b[2] - b[0] * a[2];
  }
  return Math.abs(s) / 2;
}

/* ---------- геометрия ---------- */

/**
 * Лента вдоль ломаной.
 *
 * Стыки не сшиваются усом, а закрываются веером в вершине: для
 * тонкой линии ус на остром угле улетает далеко, а веер даёт
 * скруглённый стык — как у обычной обводки с круглым соединением.
 */
function ribbon(pts, halfWidth, y, out, corners = 8) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, , az] = pts[i], [bx, , bz] = pts[i + 1];
    let dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    dx /= len; dz /= len;
    const nx = -dz * halfWidth, nz = dx * halfWidth;
    const p = [
      [ax + nx, az + nz], [bx + nx, bz + nz],
      [bx - nx, bz - nz], [ax - nx, az - nz]
    ];
    out.push(p[0][0], y, p[0][1], p[1][0], y, p[1][1], p[2][0], y, p[2][1]);
    out.push(p[0][0], y, p[0][1], p[2][0], y, p[2][1], p[3][0], y, p[3][1]);
  }
  // круглые стыки и торцы
  for (let i = 0; i < pts.length; i++) disc(pts[i][0], pts[i][2], halfWidth, y, out, corners);
}

function disc(cx, cz, r, y, out, seg = 16) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    out.push(cx, y, cz,
             cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r,
             cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r);
  }
}

/** Триангуляция выпуклой развёрткой: контуры разметки рисует человек. */
function fan(pts, y, out) {
  for (let i = 1; i < pts.length - 1; i++) {
    out.push(pts[0][0], y, pts[0][2],
             pts[i][0], y, pts[i][2],
             pts[i + 1][0], y, pts[i + 1][2]);
  }
}

const meshOf = (positions, color, y, opts = {}) => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, side: THREE.DoubleSide,
    transparent: opts.opacity != null, opacity: opts.opacity ?? 1,
    depthWrite: opts.depthWrite !== false
  }));
  m.renderOrder = opts.order ?? 1;
  return m;
};

/* ---------- объекты разметки ---------- */

export const KINDS = {
  line:  { name: 'линия',    min: 2 },
  area:  { name: 'площадка', min: 3 },
  point: { name: 'метка',    min: 1 }
};

const ACCENT = 0xb4472c;
const BUFFER = 0xd8a291;

/**
 * Собирает три меша объекта: буфер, заливку и саму линию.
 *
 * Буфер намеренно непрозрачный. Полупрозрачные пятна складываются
 * там, где перекрываются, и одна зона из двух отрезков выходит
 * пятнистой; сплошная заливка светлым тоном читается ровно и не
 * спорит с серым макетом.
 */
export function buildItem(item) {
  const out = [];
  const y = item.y;

  if (item.buffer > 0 && item.pts.length >= 1) {
    const pos = [];
    if (item.kind === 'point') disc(item.pts[0][0], item.pts[0][2], item.buffer, y + 0.10, pos, 40);
    else if (item.kind === 'line') ribbon(item.pts, item.buffer, y + 0.10, pos, 16);
    else {
      // Для площадки буфер строится как её контур, обведённый лентой,
      // плюс сама площадка: точное смещение полигона наружу требует
      // разбора самопересечений, а на глаз разницы нет.
      const closed = [...item.pts, item.pts[0]];
      ribbon(closed, item.buffer, y + 0.10, pos, 16);
      fan(item.pts, y + 0.10, pos);
    }
    out.push(meshOf(pos, BUFFER, y, { order: 1 }));
  }

  if (item.kind === 'area' && item.pts.length >= 3) {
    const pos = [];
    fan(item.pts, y + 0.20, pos);
    out.push(meshOf(pos, ACCENT, y, { opacity: 0.22, depthWrite: false, order: 2 }));
  }

  const pos = [];
  if (item.kind === 'point') {
    disc(item.pts[0][0], item.pts[0][2], 2.2, y + 0.30, pos, 20);
  } else if (item.pts.length >= 2) {
    const line = item.kind === 'area' ? [...item.pts, item.pts[0]] : item.pts;
    ribbon(line, 1.1, y + 0.30, pos, 10);
  }
  if (pos.length) out.push(meshOf(pos, ACCENT, y, { order: 3 }));

  return out;
}

/**
 * Маркеры вершин выбранного объекта.
 *
 * Без них разметка выглядит нарисованной намертво: непонятно, из чего
 * она состоит и за что её можно взять. Маркер — это и обозначение, и
 * мишень для перетаскивания.
 */
export function vertexMarkers(item, dragging = -1) {
  const pos = [];
  item.pts.forEach(([x, , z], i) => {
    disc(x, z, i === dragging ? 3.0 : 2.2, item.y + 0.45, pos, 14);
  });
  return pos.length ? [meshOf(pos, 0x1b1a18, item.y, { order: 4 })] : [];
}

/** Незаконченная ломаная тянется за курсором. */
export function ghost(pts, y, kind) {
  const pos = [];
  const line = kind === 'area' && pts.length > 2 ? [...pts, pts[0]] : pts;
  if (line.length >= 2) ribbon(line, 0.8, y + 0.28, pos, 8);
  for (const [x, , z] of pts) disc(x, z, 1.6, y + 0.45, pos, 12);
  return pos.length ? [meshOf(pos, ACCENT, y, { opacity: 0.55, depthWrite: false, order: 4 })] : [];
}

/** Ближайший объект разметки под точкой: чем его выбирают. */
export function hitTest(items, x, z, tol = 4) {
  let best = null, bestD = Infinity;
  for (const it of items) {
    const d = distToItem(it, x, z);
    if (d < bestD) { bestD = d; best = it; }
  }
  return bestD <= tol ? best : null;
}

function distToItem(item, x, z) {
  if (item.kind === 'point') return Math.hypot(x - item.pts[0][0], z - item.pts[0][2]);
  if (item.kind === 'area' && pointInRing(x, z, item.pts)) return 0;
  const line = item.kind === 'area' ? [...item.pts, item.pts[0]] : item.pts;
  let d = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    d = Math.min(d, distToSegment(x, z, line[i], line[i + 1]));
  }
  return d;
}

/** Номер вершины под точкой — за неё берутся при перетаскивании. */
export function nearestVertex(item, x, z, tol = 5) {
  let idx = -1, best = tol;
  item.pts.forEach(([px, , pz], i) => {
    const d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; idx = i; }
  });
  return idx;
}

/** Подпись объекта в списке: что это и сколько намерено. */
export function describe(item) {
  const m = (v) => v >= 1000 ? `${(v / 1000).toFixed(2)} км` : `${v.toFixed(0)} м`;
  const m2 = (v) => v >= 1e4 ? `${(v / 1e4).toFixed(2)} га` : `${Math.round(v).toLocaleString('ru')} м²`;
  if (item.kind === 'line') {
    const len = lineLength(item.pts);
    return `${m(len)}${item.buffer ? ` · буфер ${item.buffer} м · ${m2(len * item.buffer * 2 + Math.PI * item.buffer ** 2)}` : ''}`;
  }
  if (item.kind === 'area') {
    const a = ringArea(item.pts);
    return `${m2(a)} · периметр ${m(lineLength([...item.pts, item.pts[0]]))}${item.buffer ? ` · буфер ${item.buffer} м` : ''}`;
  }
  return item.buffer
    ? `буфер ${item.buffer} м · ${m2(Math.PI * item.buffer ** 2)}`
    : 'точка';
}

/** Здания, попавшие в объект: считаем по центру пятна. */
export function buildingsInside(item, index) {
  const hits = [];
  for (const e of index) {
    const b = e.b;
    if (!b.bbox) continue;
    const cx = (b.bbox[0] + b.bbox[2]) / 2, cz = (b.bbox[1] + b.bbox[3]) / 2;
    if (inside(item, cx, cz)) hits.push(e);
  }
  return hits;
}

function inside(item, x, z) {
  const r = item.buffer || 0;
  if (item.kind === 'point') {
    return Math.hypot(x - item.pts[0][0], z - item.pts[0][2]) <= r;
  }
  if (item.kind === 'area' && pointInRing(x, z, item.pts)) return true;
  const line = item.kind === 'area' ? [...item.pts, item.pts[0]] : item.pts;
  if (r <= 0) return false;
  for (let i = 0; i < line.length - 1; i++) {
    if (distToSegment(x, z, line[i], line[i + 1]) <= r) return true;
  }
  return false;
}

function pointInRing(x, z, ring) {
  let on = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][2], xj = ring[j][0], zj = ring[j][2];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) on = !on;
  }
  return on;
}

function distToSegment(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - a[0]) * dx + (pz - a[2]) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a[0] + dx * t), pz - (a[2] + dz * t));
}
