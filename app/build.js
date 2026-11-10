/* ============================================================
   Сборка геометрии из разобранных данных OSM.

   Модуль работает внутри веб-воркера: three импортируется по
   прямому пути (карта импорта в воркеры не наследуется), а на
   выход отдаются типизированные массивы, которые переезжают в
   главный поток без копирования.
   ============================================================ */

import * as THREE from '../vendor/three.module.js';
import { ringArea, centroid, pointInRing } from './geo.js';
import { terrainAt } from './terrain.js';

/* ---------- слияние геометрий ---------- */
// Своя реализация вместо BufferGeometryUtils: тот модуль импортирует
// three по имени, а карта импорта в веб-воркеры не наследуется.
// Нам достаточно склейки треугольных списков с одинаковым набором
// атрибутов, поэтому всё приводится к неиндексированному виду.

function mergeAll(geoms, attrs) {
  const flat = geoms.map(g => (g.index ? g.toNonIndexed() : g));
  const total = flat.reduce((s, g) => s + g.attributes.position.count, 0);
  const out = {};
  for (const name of attrs) out[name] = new Float32Array(total * 3);

  let offset = 0;
  for (const g of flat) {
    const n = g.attributes.position.count;
    for (const name of attrs) {
      const a = g.attributes[name];
      if (a) out[name].set(a.array.subarray(0, n * 3), offset * 3);
    }
    offset += n;
  }
  flat.forEach(g => g.dispose());
  geoms.forEach(g => { if (!flat.includes(g)) g.dispose(); });
  return { ...out, count: total };
}

/* ---------- обрезка по выпуклому окну (Сазерленд — Ходжман) ---------- */

/**
 * Готовит окно обрезки: сам многоугольник, квадрат радиуса для
 * быстрой проверки и знак «внутренней» стороны рёбер. Круг задан
 * многоугольником, поэтому алгоритм тот же, что был для прямоугольника.
 */
export function makeClip(win) {
  let r2 = 0;
  for (const [x, z] of win) r2 = Math.max(r2, x * x + z * z);
  const a = win[0], b = win[1];
  const sgn = Math.sign((b[0] - a[0]) * (0 - a[1]) - (b[1] - a[1]) * (0 - a[0])) || 1;
  return { win, r2, sgn };
}

const sideOf = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

function clipRing(ring, clip) {
  // Подавляющее большинство зданий лежит внутри целиком — проверяем
  // это одним проходом и не запускаем обрезку зря.
  let outside = false;
  for (const [x, z] of ring) {
    if (x * x + z * z > clip.r2) { outside = true; break; }
  }
  if (!outside) return ring;

  let poly = ring.slice(0, -1);
  const w = clip.win, n = w.length;

  for (let i = 0; i < n && poly.length; i++) {
    const a = w[i], b = w[(i + 1) % n];
    const next = [];
    for (let j = 0; j < poly.length; j++) {
      const cur = poly[j], prev = poly[(j + poly.length - 1) % poly.length];
      const dc = sideOf(a, b, cur) * clip.sgn;
      const dp = sideOf(a, b, prev) * clip.sgn;
      if (dc >= 0) {
        if (dp < 0) next.push(cross(prev, cur, dp, dc));
        next.push(cur);
      } else if (dp >= 0) {
        next.push(cross(prev, cur, dp, dc));
      }
    }
    poly = next;
  }
  if (poly.length < 3) return null;
  poly.push(poly[0]);
  return poly;
}

function cross(p, c, dp, dc) {
  const t = dp / (dp - dc);
  return [p[0] + (c[0] - p[0]) * t, p[1] + (c[1] - p[1]) * t];
}

/* ---------- полигон → THREE.Shape ---------- */
// Кольца идут в координатах (x, z); в Shape кладём (x, −z), чтобы
// после поворота меша на −90° по X план совпал с планом сцены.

function toShape(rings) {
  const outer = rings[0];
  if (!outer || outer.length < 4) return null;
  const shape = new THREE.Shape(outer.slice(0, -1).map(p => new THREE.Vector2(p[0], -p[1])));
  for (let i = 1; i < rings.length; i++) {
    const h = rings[i];
    if (h.length < 4) continue;
    shape.holes.push(new THREE.Path(h.slice(0, -1).map(p => new THREE.Vector2(p[0], -p[1]))));
  }
  return shape;
}

/**
 * Пояс вокруг здания: карниз, цоколь или парапет.
 *
 * Лента идёт по контуру, отодвинутая наружу на вынос. Смещать каждый
 * отрезок по своей нормали независимо нельзя: на углах ленты
 * расходятся, и по верху дома идут зубцы вместо ровной полки. Поэтому
 * выносится каждая вершина по биссектрисе смежных нормалей, с
 * поправкой на острый угол — обычный ус, как в обводке контуров.
 * Поправка ограничена: на игольчатых выступах пятна ус иначе улетает
 * на десятки метров.
 */
function belt(ring, y, h, out, pos, inner = false) {
  const n = ring.length - 1;
  if (n < 3) return;

  const seg = [];                       // нормаль каждого отрезка
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % n];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    seg.push([-dz / len, dx / len]);
  }

  const off = [];                       // вершина, вынесенная наружу
  for (let i = 0; i < n; i++) {
    const a = seg[(i - 1 + n) % n], b = seg[i];
    let mx = a[0] + b[0], mz = a[1] + b[1];
    const m = Math.hypot(mx, mz);
    if (m < 1e-4) { off.push([ring[i][0] + b[0] * out, ring[i][1] + b[1] * out]); continue; }
    mx /= m; mz /= m;
    // Вынос уса ограничен вдвое: на входящих углах биссектриса
    // разворачивается, и без потолка пояс выстреливал шипами.
    const k = Math.min(out * 2, out / Math.max(0.5, mx * b[0] + mz * b[1]));
    off.push([ring[i][0] + mx * k, ring[i][1] + mz * k]);
  }

  const tri = (p, q, r) => pos.push(...p, ...q, ...r);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = ring[i], b = ring[j], oa = off[i], ob = off[j];
    const T = (p) => [p[0], y + h, p[1]];
    const B = (p) => [p[0], y, p[1]];
    tri(B(oa), B(ob), T(ob)); tri(B(oa), T(ob), T(oa));      // лицо
    tri(T(oa), T(ob), T(b));  tri(T(oa), T(b), T(a));        // верхняя полка
    // Парапет стоит на кровле, а не на стене, поэтому у него открыта
    // внутренняя сторона: сквозь щель между полкой и кровлей была
    // видна изнанка, и по дальнему краю крыши шли тёмные выщербины.
    if (inner) { tri(T(b), B(b), B(a)); tri(T(b), B(a), T(a)); }
  }
}

/* ---------- скатные кровли ---------- */

/** Выпуклая оболочка обходом Эндрю: нужна для поиска габарита. */
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (src) => {
    const out = [];
    for (const q of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return [...half(p), ...half(p.reverse())];
}

/**
 * Главная ось пятна и его габариты в повёрнутой системе.
 *
 * Конёк двускатной крыши идёт вдоль длинной стороны дома, поэтому
 * сначала нужно понять, куда этот дом вытянут.
 *
 * Ось ищем минимальным охватывающим прямоугольником. Прежде здесь
 * стоял разброс координат относительно центра — второй момент, — и
 * он врал везде, где вершины стоят неравномерно: у длинного дома с
 * подробно обведённым торцом и двумя точками на всю продольную стену
 * «главной» оказывалась поперечная ось, и конёк ложился поперёк
 * дома. Прямоугольник минимальной площади от разметки контура не
 * зависит вовсе.
 *
 * По теореме о вращающихся штангенциркулях одна сторона искомого
 * прямоугольника лежит на ребре выпуклой оболочки, поэтому достаточно
 * перебрать рёбра оболочки — их единицы.
 */
function mainAxis(ring) {
  const n = ring.length - 1;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += ring[i][0]; cz += ring[i][1]; }
  cx /= n; cz /= n;

  const pts = [];
  for (let i = 0; i < n; i++) pts.push([ring[i][0] - cx, ring[i][1] - cz]);
  const hull = convexHull(pts);

  const extent = (a) => {
    const cos = Math.cos(-a), sin = Math.sin(-a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [dx, dz] of pts) {
      const u = dx * cos - dz * sin, v = dx * sin + dz * cos;
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    return { u0, u1, v0, v1, area: (u1 - u0) * (v1 - v0) };
  };

  let best = null, angle = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    if (Math.hypot(dx, dz) < 1e-6) continue;
    const th = Math.atan2(dz, dx);
    const e = extent(th);
    if (!best || e.area < best.area) { best = e; angle = th; }
  }
  if (!best) { best = extent(0); angle = 0; }

  return { cx, cz, angle, u0: best.u0, u1: best.u1, v0: best.v0, v1: best.v1, area: best.area };
}

const ROOF_PITCH = {
  gabled: 0.42, hipped: 0.40, pyramidal: 0.55, mansard: 0.34,
  gambrel: 0.38, half_hipped: 0.40, round: 0.34, dome: 0.5, skillion: 0.30
};

/**
 * Строит кровлю над пятном здания.
 *
 * Форма берётся из тега `roof:shape`, высота — из `roof:height`, а
 * если его нет, из пропорции к короткой стороне: у скатной кровли
 * подъём связан с пролётом, а не с высотой дома.
 *
 * Кровля ставится на габаритный прямоугольник, а не на точный контур:
 * для сложных в плане зданий это было бы враньё, поэтому сложные
 * пятна остаются плоскими — проверяем, насколько контур заполняет
 * свой прямоугольник.
 */
export function roofPlan(ring, tags) {
  const shape = tags['roof:shape'];
  if (!shape || shape === 'flat') return null;
  const pitch = ROOF_PITCH[shape];
  if (!pitch) return null;

  const ax = mainAxis(ring);
  const fill = Math.abs(ringArea(ring)) / Math.max(ax.area, 1);
  if (fill < 0.78) return null;                 // не прямоугольное пятно

  const span = Math.min(ax.u1 - ax.u0, ax.v1 - ax.v0);
  if (span < 3) return null;

  const explicit = parseFloat(tags['roof:height']);
  const byLevels = parseFloat(tags['roof:levels']) * 2.6;
  const h = isFinite(explicit) ? explicit
          : isFinite(byLevels) ? byLevels
          : Math.min(span * pitch, 9);
  if (!(h > 0.4)) return null;
  return { shape, h, ax };
}

/**
 * Скатная кровля.
 *
 * Кровля выпускается за плоскость стены: свес в полметра с тонкой
 * лобовой доской по краю. Без него скат упирается в стену встык, и
 * дом выглядит склеенным из двух коробок, а не покрытым крышей —
 * в клеевом рендере это первое, что выдаёт схему.
 */
function buildRoof(plan, top, pos) {
  const { shape, h, ax } = plan;
  const OV = 0.5;                     // свес
  const FASCIA = 0.28;                // лобовая доска
  const cx = ax.cx, cz = ax.cz, angle = ax.angle;
  const u0 = ax.u0 - OV, u1 = ax.u1 + OV, v0 = ax.v0 - OV, v1 = ax.v1 + OV;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // обратный поворот: из системы дома в систему сцены
  const P = (u, v, y) => {
    const x = u * cos - v * sin, z = u * sin + v * cos;
    return [cx + x, y, cz + z];
  };
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);

  const long = (u1 - u0) >= (v1 - v0);
  const peak = top + h;

  if (shape === 'pyramidal' || shape === 'dome') {
    const apex = P((u0 + u1) / 2, (v0 + v1) / 2, peak);
    const c1 = P(u0, v0, top), c2 = P(u1, v0, top);
    const c3 = P(u1, v1, top), c4 = P(u0, v1, top);
    tri(c1, c2, apex); tri(c2, c3, apex); tri(c3, c4, apex); tri(c4, c1, apex);
    return;
  }

  if (shape === 'skillion') {
    // Односкатная: одна длинная сторона поднята.
    const a = P(u0, v0, top), b = P(u1, v0, long ? peak : top);
    const c = P(u1, v1, peak), d = P(u0, v1, long ? top : peak);
    tri(a, b, c); tri(a, c, d);
    tri(P(u0, v0, top), P(u0, v1, top), d);
    tri(P(u1, v0, top), c, P(u1, v1, top));
    return;
  }

  // Двускатная и вальмовая: конёк вдоль длинной стороны. У вальмовой
  // он короче пятна, поэтому торцы становятся скатами, а не фронтонами.
  const inset = shape === 'hipped' || shape === 'half_hipped'
    ? Math.min((long ? v1 - v0 : u1 - u0) / 2, (long ? u1 - u0 : v1 - v0) * 0.3)
    : 0;

  // Лобовая доска по периметру свеса.
  const fascia = () => {
    const c = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      const A = P(a[0], a[1], top), B = P(b[0], b[1], top);
      const Ad = P(a[0], a[1], top - FASCIA), Bd = P(b[0], b[1], top - FASCIA);
      tri(Ad, Bd, B); tri(Ad, B, A);
    }
  };
  fascia();

  // Дымник на коньке: у скатной кровли он есть почти всегда, а в
  // силуэте квартала эти вертикальные штрихи и отличают жилую
  // застройку от промышленной.
  const stack = (u, v) => {
    const s = 0.45, hh = 1.3;
    const c = [[u - s, v - s], [u + s, v - s], [u + s, v + s], [u - s, v + s]];
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      const A = P(a[0], a[1], peak), B = P(b[0], b[1], peak);
      const At = P(a[0], a[1], peak + hh), Bt = P(b[0], b[1], peak + hh);
      tri(A, B, Bt); tri(A, Bt, At);
    }
    const T = c.map(([x, z]) => P(x, z, peak + hh));
    tri(T[0], T[1], T[2]); tri(T[0], T[2], T[3]);
  };

  if (long) {
    const vm = (v0 + v1) / 2;
    const r0 = P(u0 + inset, vm, peak), r1 = P(u1 - inset, vm, peak);
    const a = P(u0, v0, top), b = P(u1, v0, top);
    const c = P(u1, v1, top), d = P(u0, v1, top);
    tri(a, b, r1); tri(a, r1, r0);          // скат к одной стороне
    tri(c, d, r0); tri(c, r0, r1);          // скат к другой
    if (inset > 0.01) { tri(a, r0, d); tri(b, c, r1); }
    else { tri(a, r0, d); tri(b, c, r1); }  // фронтоны
    const vmid = (v0 + v1) / 2;
    stack(u0 + (u1 - u0) * 0.26, vmid);
    if (u1 - u0 > 34) stack(u0 + (u1 - u0) * 0.72, vmid);
  } else {
    const um = (u0 + u1) / 2;
    const r0 = P(um, v0 + inset, peak), r1 = P(um, v1 - inset, peak);
    const a = P(u0, v0, top), b = P(u0, v1, top);
    const c = P(u1, v1, top), d = P(u1, v0, top);
    tri(a, b, r1); tri(a, r1, r0);
    tri(c, d, r0); tri(c, r0, r1);
    tri(a, r0, d); tri(b, c, r1);
    const umid = (u0 + u1) / 2;
    stack(umid, v0 + (v1 - v0) * 0.26);
    if (v1 - v0 > 34) stack(umid, v0 + (v1 - v0) * 0.72);
  }
}

/* ---------- объёмы застройки ---------- */

// Тон клеевого макета: почти белый гипс, светотень держится не на
// разнице тонов, а на затенении в примыканиях и на длинной мягкой
// тени. Оценочные высоты чуть темнее — их видно, но они не выпадают
// из общей массы.
const COL_WALL  = [0.780, 0.777, 0.768];
const COL_ROOF  = [0.860, 0.857, 0.848];
const COL_EST_W = [0.672, 0.668, 0.658];
const COL_EST_R = [0.760, 0.756, 0.746];

export function buildBuildings(buildings, clip, terrain, radius = 1) {
  const geoms = [], index = [];
  let stepped = 0, stepCand = 0;
  const bases = [], delays = [];
  let triOffset = 0;

  for (const b of buildings) {
    const rings = b.rings.map(r => clipRing(r, clip)).filter(Boolean);
    if (!rings.length || rings[0].length < 4) continue;

    const shape = toShape(rings);
    if (!shape) continue;

    // Посадка на рельеф: верх отсчитываем от отметки в центре пятна,
    // низ опускаем до самой низкой точки контура, чтобы на склоне
    // здание не висело в воздухе и не тонуло.
    let ground = 0, lowest = 0;
    if (terrain) {
      const c = centroid(rings[0]);
      ground = terrainAt(terrain, c[0], c[1]);
      lowest = ground;
      for (const p of rings[0]) lowest = Math.min(lowest, terrainAt(terrain, p[0], p[1]));
      lowest -= 1.5;
    }

    const top = ground + b.h;
    const bottom = ground + b.minH;

    // Скатная кровля забирает верхнюю часть объёма, а не надстраивается
    // сверху: тег height в OSM меряется до конька, и надстройка сделала
    // бы дом выше, чем он есть.
    // Тег roof:shape в Москве почти не размечен, зато эпоха известна:
    // до революции и при Сталине строили под скатной кровлей, позже —
    // под плоской. Тег, если он есть, всё равно главнее.
    const tags = b.epoch && !b.tags['roof:shape'] && b.epoch.roof === 'gabled'
      ? { ...b.tags, 'roof:shape': 'gabled' }
      : b.tags;
    const plan = roofPlan(rings[0], tags);
    const roofH = plan ? Math.min(plan.h, (top - Math.min(bottom, lowest)) * 0.45) : 0;
    const wallTop = top - roofH;
    const depth = Math.max(wallTop - Math.min(bottom, lowest), 1.0);
    let g;
    try {
      g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
    } catch { continue; }

    g.translate(0, 0, wallTop - depth);
    g.rotateX(-Math.PI / 2);
    g.deleteAttribute('uv');
    g.computeVertexNormals();

    // Крыша чуть светлее стен — объём читается даже в контровом свете.
    const nrm = g.attributes.normal, n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    // Разнотон по зданиям. Отлитый макет никогда не бывает ровно
    // одного тона: партии гипса отличаются, что-то запылилось, что-то
    // выгорело. Без этого квартал читается одной выдавленной массой,
    // и глазу не за что зацепиться, чтобы отделить дом от дома.
    // Отклонение выводится из идентификатора, поэтому при повторной
    // сборке участок выглядит так же.
    let seed = 0;
    for (let i = 0; i < b.id.length; i++) seed = (seed * 31 + b.id.charCodeAt(i)) >>> 0;
    const jitter = 1 + (((seed >>> 8) % 1000) / 1000 - 0.5) * 0.085;
    const shade = (c) => [c[0] * jitter, c[1] * jitter, c[2] * jitter];
    const cw = shade(b.estimated ? COL_EST_W : COL_WALL);
    const cr = shade(b.estimated ? COL_EST_R : COL_ROOF);
    for (let i = 0; i < n; i++) {
      const c = nrm.getY(i) > 0.8 ? cr : cw;
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));

    // Данные для анимации появления: отметка низа объёма и задержка
    // старта. Волна идёт от центра участка к краю — так рост читается
    // как одно движение, а не как случайное мелькание.
    const c = centroid(rings[0]);
    const dist = Math.min(1, Math.hypot(c[0], c[1]) / radius);
    const growBase = wallTop - depth;      // фактический низ объёма

    const push = (count) => {
      for (let i = 0; i < count; i++) { bases.push(growBase); delays.push(dist * 0.55); }
    };
    push(n);

    let tris = n / 3;
    geoms.push(g);

    // Карниз и цоколь: пояса, выступающие за плоскость стены. У
    // сталинского дома вынос карниза доходит до метра и читается
    // даже на общем плане, у панельного его практически нет —
    // на этой разнице силуэты эпох и различаются.
    {
      const belts = [];
      const cornice = b.epoch ? b.epoch.cornice : 0.15;
      if (cornice > 0.3) {
        belt(rings[0], wallTop - 1.1, 1.1, cornice, belts);
      }
      if (b.epoch && b.epoch.plinth > 0.3) {
        belt(rings[0], wallTop - depth, Math.min(2.2, depth * 0.2), b.epoch.plinth * 0.6, belts);
      }
      // Парапет: на плоской кровле стена продолжается выше её плоскости.
      // Без него кровля обрывается голым ребром и дом выглядит срезанным
      // по линейке — а именно эта тонкая полоска даёт силуэту масштаб.
      if (!plan && depth > 4) {
        belt(rings[0], wallTop, cornice > 0.3 ? 0.35 : 0.6, 0.08, belts, true);
      }
      // Надстройки на плоской кровле: машинное отделение лифта и
      // вентшахта. В натуре они есть на любом доме выше пяти этажей,
      // а в силуэте квартала именно они не дают кровлям слиться в
      // ровное поле светлых прямоугольников.
      if (!plan && b.area > 300 && depth > 12) {
        const c2 = centroid(rings[0]);
        if (pointInRing(c2, rings[0])) {
          const ax = mainAxis(rings[0]);
          roofBox(c2[0], c2[1], 4.2, 3.0, wallTop, depth > 24 ? 3.0 : 2.2, belts, ax.angle);
          if (b.area > 900) {
            const off = 6;
            const x = c2[0] + Math.cos(ax.angle) * off, z = c2[1] + Math.sin(ax.angle) * off;
            if (pointInRing([x, z], rings[0])) roofBox(x, z, 1.4, 1.4, wallTop, 1.9, belts, ax.angle);
          }
        }
      }

      if (belts.length) {
        const bg = new THREE.BufferGeometry();
        bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(belts), 3));
        bg.computeVertexNormals();
        const bn = bg.attributes.position.count;
        const bc = new Float32Array(bn * 3);
        for (let i = 0; i < bn; i++) {
          bc[i * 3] = cw[0]; bc[i * 3 + 1] = cw[1]; bc[i * 3 + 2] = cw[2];
        }
        bg.setAttribute('color', new THREE.BufferAttribute(bc, 3));
        push(bn);
        geoms.push(bg);
        tris += bn / 3;
      }
    }

    // Ступени секций — только у серийной застройки: у дореволюционного
    // дома и у современного комплекса длина набирается иначе, и ровный
    // карниз там как раз правда.
    if (b.epoch && /^(khrush|late|post)$/.test(b.epoch.id)) {
      stepCand++;
      const steps = sectionSteps(b, rings, wallTop, b.epoch.floor);
      if (steps) {
        stepped++;
        for (const g of steps) {
          const sn = g.attributes.position.count;
          const sc = new Float32Array(sn * 3);
          const snrm = g.attributes.normal;
          for (let i = 0; i < sn; i++) {
            const c = snrm.getY(i) > 0.8 ? cr : cw;
            sc[i * 3] = c[0]; sc[i * 3 + 1] = c[1]; sc[i * 3 + 2] = c[2];
          }
          g.setAttribute('color', new THREE.BufferAttribute(sc, 3));
          push(sn);
          geoms.push(g);
          tris += sn / 3;
        }
      }
    }

    if (plan && roofH > 0.4) {
      const rp = [];
      buildRoof({ ...plan, h: roofH }, wallTop, rp);
      if (rp.length) {
        const rg = new THREE.BufferGeometry();
        rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rp), 3));
        rg.computeVertexNormals();
        const rn = rg.attributes.position.count;
        const rc = new Float32Array(rn * 3);
        for (let i = 0; i < rn; i++) {
          rc[i * 3] = cr[0]; rc[i * 3 + 1] = cr[1]; rc[i * 3 + 2] = cr[2];
        }
        rg.setAttribute('color', new THREE.BufferAttribute(rc, 3));
        push(rn);
        geoms.push(rg);
        tris += rn / 3;
      }
    }

    index.push({ start: triOffset, end: triOffset + tris, b: strip(b, ground, bboxOf(rings[0])) });
    triOffset += tris;
  }

  if (!geoms.length) return null;
  const m = mergeAll(geoms, ['position', 'normal', 'color']);
  return {
    positions: m.position, normals: m.normal, colors: m.color, index,
    stepped, stepCand,
    bases: new Float32Array(bases), delays: new Float32Array(delays)
  };
}

// В главный поток едет только то, что нужно карточке и статистике:
// кольца координат остаются в воркере.
function strip(b, ground, bbox) {
  return {
    id: b.id, tags: b.tags, h: b.h, levels: b.levels, area: b.area,
    estimated: b.estimated, src: b.src, ground, bbox,
    year: b.year || 0, epoch: b.epoch ? b.epoch.name : null
  };
}

// Габариты пятна нужны в главном потоке: по ним модель понимает,
// где нельзя ставить новые объёмы.
function bboxOf(ring) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return [Math.round(x0), Math.round(z0), Math.round(x1), Math.round(z1)];
}

/* ---------- плоские покрытия: вода, озеленение ---------- */

/**
 * Плоские покрытия: озеленение и вода.
 *
 * Вода кладётся горизонтально, а не по рельефу. Открытые DEM снимают
 * поверхность целиком и про реки ничего не знают: в русле у них
 * оказываются отметки выше уровня воды, и натянутая на рельеф река
 * рвалась пятнами, местами уходя под грунт. Горизонтальная плоскость
 * по низшей точке контура — и физически верно, и артефакт исчезает.
 */
export function buildAreas(areas, clip, y, terrain, flat = false) {
  const geoms = [];
  // Крупные контуры первыми, мелкие поверх: иначе газон внутри
  // парка утонет под самим парком.
  const sorted = areas.slice().sort((a, b) => b.area - a.area);

  sorted.forEach((a, i) => {
    const rings = a.rings.map(r => clipRing(r, clip)).filter(Boolean);
    if (!rings.length) return;
    const shape = toShape(rings);
    if (!shape) return;
    let g;
    try { g = new THREE.ShapeGeometry(shape, 1); } catch { return; }
    g.rotateX(-Math.PI / 2);
    g.deleteAttribute('uv');

    if (flat && terrain) {
      // Уровень воды — низшая отметка её собственного контура.
      let level = Infinity;
      for (const [x, z] of rings[0]) level = Math.min(level, terrainAt(terrain, x, z));
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) p.setY(k, level + y);
      g.computeVertexNormals();
    } else {
      // Микроступенька разводит вложенные контуры (газон внутри парка),
      // но её нельзя копить без предела: на сотне полигонов подъём
      // перерастал расстояние между слоями.
      drapeOnTerrain(g, terrain, y + Math.min(i * 0.0012, 0.02));
    }
    geoms.push(g);
  });

  if (!geoms.length) return null;
  return mergeAll(geoms, ['position']).position;
}

// Плоскую геометрию кладём на рельеф: каждой вершине — своя отметка.
function drapeOnTerrain(g, terrain, offset) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setY(i, (terrain ? terrainAt(terrain, p.getX(i), p.getZ(i)) : 0) + offset);
  }
  g.computeVertexNormals();
}

/* ---------- улично-дорожная сеть ---------- */

// Полосу собираем из четырёхугольника на сегмент и восьмиугольной
// «шайбы» в каждом узле: повороты выходят скруглёнными без разбора
// острых углов и вывернутых стыков.
/**
 * Дробит линию на отрезки не длиннее шага.
 *
 * Узлы дорог в OSM стоят редко — на прямой улице соседние точки могут
 * отстоять на сотню метров. Лента, натянутая между ними, идёт по
 * прямой, а рельеф под ней выгибается, и грунт вылезает поверх
 * проезжей части. Промежуточные точки заставляют ленту повторять
 * профиль земли.
 */
function densify(pts, step = 8) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      out.push([ax + (bx - ax) * f, az + (bz - az) * f]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function ribbon(pts, w, pos, terrain, offset) {
  const r = w / 2;
  const push = (x, z) => pos.push(x, (terrain ? terrainAt(terrain, x, z) : 0) + offset, z);

  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    let dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    dx /= len; dz /= len;
    const nx = -dz * r, nz = dx * r;
    const p1 = [ax + nx, az + nz], p2 = [bx + nx, bz + nz];
    const p3 = [bx - nx, bz - nz], p4 = [ax - nx, az - nz];
    push(p1[0], p1[1]); push(p2[0], p2[1]); push(p3[0], p3[1]);
    push(p1[0], p1[1]); push(p3[0], p3[1]); push(p4[0], p4[1]);
  }
  const SEG = 8;
  for (const [cx, cz] of pts) {
    for (let s = 0; s < SEG; s++) {
      const a0 = (s / SEG) * Math.PI * 2, a1 = ((s + 1) / SEG) * Math.PI * 2;
      push(cx, cz);
      push(cx + Math.cos(a1) * r, cz + Math.sin(a1) * r);
      push(cx + Math.cos(a0) * r, cz + Math.sin(a0) * r);
    }
  }
}

// Длинные магистрали и реки тянутся на километры за пределы кадра —
// оставляем только куски внутри участка. Для линий хватает проверки
// по радиусу: доля миллиметра на краю ленты роли не играет.
function clipLine(pts, clip) {
  const inside = p => p[0] * p[0] + p[1] * p[1] <= clip.r2;
  const chunks = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    if (inside(pts[i])) {
      // Входим в участок — начинаем не с внешней точки, а ровно
      // с границы: иначе лента торчит усом за окружность.
      if (!cur.length && i > 0) cur.push(onBorder(pts[i], pts[i - 1], clip.r2));
      cur.push(pts[i]);
    } else if (cur.length) {
      cur.push(onBorder(cur[cur.length - 1], pts[i], clip.r2));
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) chunks.push(cur);
  return chunks.filter(c => c.length > 1);
}

// Точка пересечения отрезка «внутри → снаружи» с окружностью участка.
function onBorder(inPt, outPt, r2) {
  const dx = outPt[0] - inPt[0], dz = outPt[1] - inPt[1];
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return inPt.slice();
  const b = 2 * (inPt[0] * dx + inPt[1] * dz);
  const c = inPt[0] * inPt[0] + inPt[1] * inPt[1] - r2;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return inPt.slice();
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  const k = Math.max(0, Math.min(1, t));
  return [inPt[0] + dx * k, inPt[1] + dz * k];
}

export function buildRoads(roads, clip, terrain) {
  const main = [], soft = [], decks = [];
  for (const r of roads) {
    for (const chunk of clipLine(r.pts, clip)) {
      if (r.bridge) {
        // Мостовое полотно — плита с толщиной: сверху проезжая часть,
        // по краям видна кромка. Плоская лента над рекой смотрелась
        // приклеенной к воздуху.
        deck(densify(chunk, 12), r.w, decks, terrain, r.bridge);
      } else {
        ribbon(densify(chunk), r.w, r.soft ? soft : main, terrain, r.soft ? 0.24 : 0.32);
      }
    }
  }
  return {
    main: main.length ? new Float32Array(main) : null,
    soft: soft.length ? new Float32Array(soft) : null,
    bridges: decks.length ? new Float32Array(decks) : null
  };
}

// Плита моста: верх, низ и две боковые кромки вдоль оси.
function deck(pts, w, pos, terrain, rise) {
  const r = w / 2, thick = 0.9;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    let dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) continue;
    dx /= len; dz /= len;
    const nx = -dz * r, nz = dx * r;

    const base = (x, z) => (terrain ? terrainAt(terrain, x, z) : 0) + rise;
    const corners = [
      [ax + nx, az + nz], [bx + nx, bz + nz],
      [bx - nx, bz - nz], [ax - nx, az - nz]
    ];
    const yTop = corners.map(([x, z]) => base(x, z));
    const yBot = yTop.map(v => v - thick);
    const T = (k) => [corners[k][0], yTop[k], corners[k][1]];
    const B = (k) => [corners[k][0], yBot[k], corners[k][1]];
    const tri = (a, b, c) => pos.push(...a, ...b, ...c);

    tri(T(0), T(1), T(2)); tri(T(0), T(2), T(3));       // полотно
    tri(B(0), B(2), B(1)); tri(B(0), B(3), B(2));       // низ
    for (const [p, q] of [[0, 1], [2, 3]]) {            // кромки
      tri(T(p), B(p), B(q)); tri(T(p), B(q), T(q));
    }
  }
}

/* ============================================================
   Населённость сцены: деревья, транспорт, мачты освещения.

   Голый массинг читается как схема, а не как место. Эти объекты
   ничего не добавляют к анализу, зато возвращают масштаб: рядом с
   машиной сразу понятно, что дом четырёхэтажный, а не восьми.

   Всё отдаётся плоскими массивами по пять чисел на объект
   (x, y, z, размер, поворот) и рисуется инстансингом — тысячи
   деревьев стоят один вызов отрисовки.
   ============================================================ */

// Детерминированный шум: при одинаковом участке расстановка не пляшет
// от запуска к запуску.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DENSITY = {          // квадратных метров на одно дерево
  forest: 90, wood: 90, scrub: 140, orchard: 110,
  park: 200, garden: 180, cemetery: 240, village_green: 260,
  grass: 420, meadow: 500, grassland: 500, recreation_ground: 320,
  allotments: 260, heath: 400, pitch: 0, playground: 0, dog_park: 0
};

export function buildTrees(green, osmTrees, clip, terrain, buildings) {
  const rand = rng(20260802);
  const out = [];
  const MAX = 7000;

  const inside = (x, z) => x * x + z * z <= clip.r2;
  // Не сажаем деревья в пятнах домов: габаритов достаточно, точная
  // проверка по контуру на тысячах точек себя не окупает.
  const boxes = buildings.map(b => bboxOf(b.rings[0]));
  const onBuilding = (x, z) => boxes.some(b => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);

  const put = (x, z, big) => {
    if (out.length >= MAX * 5 || !inside(x, z) || onBuilding(x, z)) return;
    const h = (big ? 7 : 5) + rand() * (big ? 5 : 3);
    out.push(x, terrain ? terrainAt(terrain, x, z) : 0, z, h, rand() * Math.PI * 2);
  };

  for (const [x, z] of osmTrees) put(x, z, true);

  for (const area of green) {
    const step = DENSITY[area.kind] ?? 0;
    if (!step) continue;
    const ring = area.rings[0];
    const bb = bboxOf(ring);
    const cell = Math.sqrt(step);
    for (let z = bb[1]; z < bb[3]; z += cell) {
      for (let x = bb[0]; x < bb[2]; x += cell) {
        // Сетка с дрожанием: правильные ряды в парке выглядят как сад,
        // а не как роща.
        const px = x + (rand() - 0.5) * cell * 0.9;
        const pz = z + (rand() - 0.5) * cell * 0.9;
        if (pointInRing([px, pz], ring)) put(px, pz, false);
      }
    }
  }
  return new Float32Array(out);
}

const CAR_ON = /^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service)$/;

export function buildCars(roads, clip, terrain) {
  const rand = rng(770);
  const out = [];
  const MAX = 1400;

  for (const r of roads) {
    if (!CAR_ON.test(r.cls)) continue;
    const lane = r.w * 0.26;                 // смещение от осевой
    const gap = r.cls === 'service' ? 60 : 34;

    for (const chunk of clipLine(r.pts, clip)) {
      for (let i = 0; i < chunk.length - 1; i++) {
        const [ax, az] = chunk[i], [bx, bz] = chunk[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 6) continue;
        const n = Math.floor(len / gap);
        for (let k = 0; k < n; k++) {
          if (out.length >= MAX * 5) break;
          if (rand() > 0.55) continue;       // не сплошной поток
          const f = (k + 0.2 + rand() * 0.6) / Math.max(n, 1);
          const dx = (bx - ax) / len, dz = (bz - az) / len;
          const side = rand() < 0.5 ? 1 : -1;
          const x = ax + (bx - ax) * f - dz * lane * side;
          const z = az + (bz - az) * f + dx * lane * side;
          if (x * x + z * z > clip.r2) continue;
          out.push(x, terrain ? terrainAt(terrain, x, z) : 0, z,
                   0.9 + rand() * 0.35, Math.atan2(dx, dz));
        }
      }
    }
  }
  return new Float32Array(out);
}

const LAMP_ON = /^(primary|secondary|tertiary|residential|living_street|pedestrian)$/;

export function buildLamps(lamps, roads, clip, terrain) {
  const rand = rng(1414);
  const out = [];
  const MAX = 900;

  const put = (x, z, rot) => {
    if (out.length >= MAX * 5 || x * x + z * z > clip.r2) return;
    out.push(x, terrain ? terrainAt(terrain, x, z) : 0, z, 7.5 + rand() * 1.5, rot);
  };

  for (const [x, z] of lamps) put(x, z, rand() * Math.PI * 2);

  // Если фонарей в данных нет — расставляем сами вдоль улиц: ритм
  // мачт задаёт масштаб не хуже машин.
  if (lamps.length < 12) {
    for (const r of roads) {
      if (!LAMP_ON.test(r.cls)) continue;
      for (const chunk of clipLine(r.pts, clip)) {
        for (let i = 0; i < chunk.length - 1; i++) {
          const [ax, az] = chunk[i], [bx, bz] = chunk[i + 1];
          const len = Math.hypot(bx - ax, bz - az);
          const n = Math.floor(len / 38);
          for (let k = 0; k < n; k++) {
            const f = (k + 0.5) / Math.max(n, 1);
            const dx = (bx - ax) / len, dz = (bz - az) / len;
            const off = r.w * 0.55 * (k % 2 ? 1 : -1);
            put(ax + (bx - ax) * f - dz * off, az + (bz - az) * f + dx * off, 0);
          }
        }
      }
    }
  }
  return new Float32Array(out);
}

/**
 * Ограды, стены и живые изгороди — низкие стенки вдоль линии.
 * Отдельная геометрия, а не инстансы: длины отрезков все разные.
 */
export function buildFences(fences, clip, terrain) {
  const pos = [];
  for (const f of fences) {
    for (const raw of clipLine(f.pts, clip)) {
      const chunk = densify(raw, 14);
      const half = f.w / 2;
      for (let i = 0; i < chunk.length - 1; i++) {
        const [ax, az] = chunk[i], [bx, bz] = chunk[i + 1];
        let dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 0.5) continue;
        dx /= len; dz /= len;
        const nx = -dz * half, nz = dx * half;

        const y = (x, z) => (terrain ? terrainAt(terrain, x, z) : 0);
        const p = [
          [ax + nx, az + nz], [bx + nx, bz + nz],
          [bx - nx, bz - nz], [ax - nx, az - nz]
        ];
        // Верх ограды идёт единой линией по концам отрезка, а не по
        // каждому углу коробки: иначе на склоне соседние звенья
        // расходились по высоте и забор рассыпался на зубцы.
        const ya = y(ax, az), yb2 = y(bx, bz);
        const yb = [ya, yb2, yb2, ya];
        const yt = [ya + f.h, yb2 + f.h, yb2 + f.h, ya + f.h];

        // четыре боковые грани и крышка
        const quad = (i0, i1) => {
          pos.push(p[i0][0], yb[i0], p[i0][1], p[i1][0], yb[i1], p[i1][1], p[i1][0], yt[i1], p[i1][1]);
          pos.push(p[i0][0], yb[i0], p[i0][1], p[i1][0], yt[i1], p[i1][1], p[i0][0], yt[i0], p[i0][1]);
        };
        quad(0, 1); quad(1, 2); quad(2, 3); quad(3, 0);
        pos.push(p[0][0], yt[0], p[0][1], p[1][0], yt[1], p[1][1], p[2][0], yt[2], p[2][1]);
        pos.push(p[0][0], yt[0], p[0][1], p[2][0], yt[2], p[2][1], p[3][0], yt[3], p[3][1]);
      }
    }
  }
  return pos.length ? new Float32Array(pos) : null;
}


/** Габарит кольца: дешёвая отсечка перед точным расстоянием. */
function ringBBox(ring) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return [x0, z0, x1, z1];
}

/** Расстояние от точки до ломаной кольца (без знака). */
function distToRing(px, pz, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[i + 1];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (ax + dx * t), ez = pz - (az + dz * t);
    const d = ex * ex + ez * ez;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}


/** Коробка на кровле: машинное отделение, вентшахта, выход на крышу. */
function roofBox(cx, cz, w, d, y, h, out, angle = 0) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const P = (u, v) => [cx + u * cos - v * sin, cz + u * sin + v * cos];
  const c = [P(-w / 2, -d / 2), P(w / 2, -d / 2), P(w / 2, d / 2), P(-w / 2, d / 2)];
  const tri = (a, b, e) => out.push(...a, ...b, ...e);
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    tri([a[0], y, a[1]], [b[0], y, b[1]], [b[0], y + h, b[1]]);
    tri([a[0], y, a[1]], [b[0], y + h, b[1]], [a[0], y + h, a[1]]);
  }
  const T = c.map(([x, z]) => [x, y + h, z]);
  tri(T[0], T[1], T[2]); tri(T[0], T[2], T[3]);
}


/* ---------- секции протяжённых домов ---------- */

/**
 * Уступы по высоте у длинных серийных домов.
 *
 * Панельный дом в сто с лишним метров — это не один объём, а несколько
 * секций, поставленных в ряд. В натуре они почти всегда разной высоты:
 * серия допускала секции в пять и девять этажей, на склоне их сажали
 * ступенями, а позже надстраивали неравномерно. Одинаковая по всей
 * длине коробка выдаёт схему сразу — квартал получается из лент, а не
 * из домов.
 *
 * Ступени строятся не разрезанием объёма, а надстройкой: основной
 * объём остаётся целым, а поверх части секций ложится дополнительный
 * этаж, вырезанный из того же пятна полосой поперёк главной оси.
 * Разрезать было бы честнее, но дороже и без выигрыша в картинке.
 *
 * Рисунок ступеней детерминирован: он выводится из идентификатора
 * здания, поэтому один и тот же дом при каждой сборке выглядит
 * одинаково — иначе повторный заход на участок давал бы другой город.
 */
function sectionSteps(b, rings, wallTop, floor) {
  const ax = mainAxis(rings[0]);
  const long = Math.max(ax.u1 - ax.u0, ax.v1 - ax.v0);
  const across = Math.min(ax.u1 - ax.u0, ax.v1 - ax.v0);
  if (long < 45 || across < 8 || long / across < 2.2) return null;

  // Секция серийного дома — примерно три подъезда, 14–16 метров.
  const n = Math.max(3, Math.round(long / 15));
  if (n < 3) return null;

  let seed = 0;
  for (let i = 0; i < b.id.length; i++) seed = (seed * 31 + b.id.charCodeAt(i)) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  const alongU = (ax.u1 - ax.u0) >= (ax.v1 - ax.v0);
  const t0 = alongU ? ax.u0 : ax.v0;
  const step = long / n;
  const cos = Math.cos(ax.angle), sin = Math.sin(ax.angle);
  const half = across;                      // с запасом: полоса режет пятно насквозь

  const out = [];
  for (let i = 0; i < n; i++) {
    if (rnd() > 0.55) continue;             // чуть больше половины секций выше
    const a = t0 + i * step, bnd = a + step;
    // Полоса поперёк главной оси, повёрнутая в систему сцены.
    const P = (u, v) => {
      const x = alongU ? u : v, z = alongU ? v : u;
      return [ax.cx + x * cos - z * sin, ax.cz + x * sin + z * cos];
    };
    const win = [P(a, -half), P(bnd, -half), P(bnd, half), P(a, half)];
    const band = clipRing(rings[0], makeClip(win));
    if (!band || band.length < 4) continue;

    const shape = toShape([band]);
    if (!shape) continue;
    // Серия допускала секции в пять, девять и двенадцать этажей,
    // и стояли они вперемешку. Ступень в один этаж на четырнадцати-
    // этажной пластине глазом не ловится — берём от одного до трёх.
    const r = rnd();
    const rise = floor * (r < 0.25 ? 3 : r < 0.6 ? 2 : 1);
    let g;
    try { g = new THREE.ExtrudeGeometry(shape, { depth: rise, bevelEnabled: false, curveSegments: 1 }); }
    catch { continue; }
    g.translate(0, 0, wallTop);
    g.rotateX(-Math.PI / 2);
    g.deleteAttribute('uv');
    g.computeVertexNormals();
    out.push(g);
  }
  return out.length ? out : null;
}

/* ---------- керн местности ---------- */

/**
 * Участок как физический образец: сверху — рельеф, по краю видна
 * толща грунта, снизу дно. Керн конечен, поэтому не нужно ни прятать
 * край плоскости дымкой, ни тянуть землю за горизонт: объект просто
 * стоит в пустоте и читается силуэтом.
 *
 * Верх строится полярной сеткой — её край точно совпадает с кромкой
 * стенки, тогда как у квадратной сетки на срезе оставались зазубрины.
 */
export function buildCore(terrain, radius, water = [], segments = 200, rings = 64) {
  const top = [], shell = [];

  // Русла врезаются в грунт. Открытые DEM снимают поверхность целиком
  // и про реки не знают: в русле у них отметки выше уровня воды, и
  // гладь оказывалась под землёй. Поэтому там, где по данным OSM
  // вода, поверхность керна опускается до её уровня.
  const basins = water.map(w => {
    let level = Infinity;
    for (const [x, z] of w.rings[0]) level = Math.min(level, terrain ? terrainAt(terrain, x, z) : 0);
    return { ring: w.rings[0], level, bbox: ringBBox(w.rings[0]) };
  });

  // Врезка не бинарная, а с откосом. Сетка керна полярная: у берега
  // её ячейка — несколько метров, и вопрос «внутри контура или нет»,
  // заданный поштучно каждой вершине, резал границу зигзагом — берег
  // выходил гребёнкой из вертикальных пластин. Теперь глубина падает
  // плавно на протяжении BANK метров по обе стороны от уреза, и
  // ступенька сетки превращается в наклон откоса.
  const BANK = 6;

  const at = (r, a) => {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const ground = (terrain ? terrainAt(terrain, x, z) : 0) - 0.05;
    let y = ground;
    for (const b of basins) {
      const bed = b.level - 0.8;
      if (ground <= bed) continue;
      if (x < b.bbox[0] - BANK || x > b.bbox[2] + BANK ||
          z < b.bbox[1] - BANK || z > b.bbox[3] + BANK) continue;
      // Внутри контура — полная глубина: иначе у берега грунт остаётся
      // выше глади и проступает сквозь воду. Откос строится снаружи,
      // от уреза к берегу.
      const k = pointInRing([x, z], b.ring)
        ? 1
        : Math.max(0, 1 - distToRing(x, z, b.ring) / BANK);
      const yy = ground + (bed - ground) * smooth(k);
      if (yy < y) y = yy;
    }
    return [x, y, z];
  };

  const smooth = (k) => k * k * (3 - 2 * k);

  for (let j = 0; j < segments; j++) {
    const a0 = (j / segments) * Math.PI * 2;
    const a1 = ((j + 1) / segments) * Math.PI * 2;

    // центральный веер
    const c = at(0, 0), i0 = at(radius / rings, a0), i1 = at(radius / rings, a1);
    top.push(...c, ...i1, ...i0);

    for (let i = 1; i < rings; i++) {
      const r0 = radius * i / rings, r1 = radius * (i + 1) / rings;
      const p00 = at(r0, a0), p01 = at(r0, a1), p10 = at(r1, a0), p11 = at(r1, a1);
      top.push(...p00, ...p01, ...p11);
      top.push(...p00, ...p11, ...p10);
    }
  }

  // Толща: глубина от самой низкой точки рельефа, чтобы стенка была
  // одинаковой на всём периметре даже на сильном склоне.
  const relief = terrain ? terrain.min : 0;
  const bottomY = relief - Math.max(45, radius * 0.22);

  for (let j = 0; j < segments; j++) {
    const a0 = (j / segments) * Math.PI * 2;
    const a1 = ((j + 1) / segments) * Math.PI * 2;
    const t0 = at(radius, a0), t1 = at(radius, a1);
    const b0 = [t0[0], bottomY, t0[2]], b1 = [t1[0], bottomY, t1[2]];

    shell.push(...t0, ...b0, ...b1);
    shell.push(...t0, ...b1, ...t1);
    // дно
    shell.push(0, bottomY, 0, ...b1, ...b0);
  }

  return {
    top: new Float32Array(top),
    shell: new Float32Array(shell),
    bottomY
  };
}

/* ---------- статистика участка ---------- */

export function stats(buildings, siteArea, clip) {
  let footprint = 0, floorArea = 0, withData = 0, maxH = 0, sumH = 0, count = 0;

  for (const b of buildings) {
    // Считаем по обрезанному пятну: здание на краю круга входит в
    // показатели ровно той частью, что попала в участок.
    const ring = clipRing(b.rings[0], clip);
    if (!ring) continue;
    const a = Math.abs(ringArea(ring));
    count++;
    footprint += a;
    const lv = b.levels ?? Math.max(1, Math.round((b.h - 1.2) / 3.0));
    floorArea += a * lv;
    if (!b.estimated) withData++;
    maxH = Math.max(maxH, b.h);
    sumH += b.h;
  }
  return {
    count, siteArea, footprint, floorArea,
    // коэффициенты считаются от площади круга
    coverage: siteArea > 0 ? footprint / siteArea : 0,
    far: siteArea > 0 ? floorArea / siteArea : 0,
    maxH, avgH: count ? sumH / count : 0,
    dataShare: count ? withData / count : 0
  };
}
