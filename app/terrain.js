/* ============================================================
   Рельеф из открытых тайлов высот (AWS Terrain Tiles, terrarium).

   Плоская земля врёт везде, где город стоит на склоне: Воробьёвы
   горы, холмы Лиссабона, террасы Тбилиси. Высоты приходят
   растровыми тайлами: h = R*256 + G + B/256 − 32768 (метры).

   Модуль рассчитан на веб-воркер: нужны fetch, createImageBitmap
   и OffscreenCanvas. Без них возвращается null — сцена просто
   остаётся плоской.
   ============================================================ */

const URLS = [
  z => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z.z}/${z.x}/${z.y}.png`
];
const TILE = 256;
const GRID = 129;              // узлов на сторону итоговой сетки высот
const MAX_TILES = 30;

const lon2tile = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2tile = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
};

function pickZoom(bbox, widthM) {
  const lat = (bbox.north + bbox.south) / 2;
  // Хотим не меньше ~96 отсчётов на ширину участка, но выше 14-го
  // зума открытые DEM всё равно интерполированы — детали не будет.
  const res = 156543.03 * Math.cos(lat * Math.PI / 180);
  const z = Math.ceil(Math.log2(96 * res / Math.max(widthM, 50)));
  return Math.max(8, Math.min(14, z));
}

export async function loadTerrain(bbox, project, pad, onProgress = () => {}) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;

  const halfW = project.width / 2 + pad;
  const halfH = project.height / 2 + pad;
  // границы расширенной области в градусах
  const [wLon, nLat] = project.unproject(-halfW, -halfH);
  const [eLon, sLat] = project.unproject(halfW, halfH);

  const z = pickZoom(bbox, project.width);
  const x0 = Math.floor(lon2tile(wLon, z)), x1 = Math.floor(lon2tile(eLon, z));
  const y0 = Math.floor(lat2tile(nLat, z)), y1 = Math.floor(lat2tile(sLat, z));
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
  if (nx * ny > MAX_TILES) return null;

  onProgress(`Рельеф: ${nx * ny} тайлов высот…`);

  const canvas = new OffscreenCanvas(nx * TILE, ny * TILE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let ok = 0;

  await Promise.all(
    Array.from({ length: nx * ny }, async (_, i) => {
      const tx = x0 + (i % nx), ty = y0 + Math.floor(i / nx);
      try {
        const res = await fetch(URLS[0]({ z, x: tx, y: ty }));
        if (!res.ok) return;
        const bmp = await createImageBitmap(await res.blob());
        ctx.drawImage(bmp, (tx - x0) * TILE, (ty - y0) * TILE);
        bmp.close();
        ok++;
      } catch { /* отсутствующий тайл — океан или дыра в покрытии */ }
    })
  );
  if (!ok) return null;

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const W = canvas.width, H = canvas.height;

  // высота по пиксельным координатам склейки, билинейно
  const samplePx = (px, py) => {
    const cx = Math.max(0, Math.min(W - 1.001, px));
    const cy = Math.max(0, Math.min(H - 1.001, py));
    const ix = Math.floor(cx), iy = Math.floor(cy);
    const fx = cx - ix, fy = cy - iy;
    const at = (x, y) => {
      const o = (y * W + x) * 4;
      return img[o] * 256 + img[o + 1] + img[o + 2] / 256 - 32768;
    };
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  };

  // Перекладываем в регулярную сетку в локальных метрах: дальше
  // ей пользуются и земля, и посадка зданий, и передача в сцену.
  const data = new Float32Array(GRID * GRID);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < GRID; j++) {
    const zw = -halfH + (2 * halfH) * j / (GRID - 1);
    for (let i = 0; i < GRID; i++) {
      const xw = -halfW + (2 * halfW) * i / (GRID - 1);
      const [lon, lat] = project.unproject(xw, zw);
      const h = samplePx(lon2tile(lon, z) * TILE - x0 * TILE, lat2tile(lat, z) * TILE - y0 * TILE);
      data[j * GRID + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }

  const rawRange = max - min;
  smooth(data, GRID);

  // Центр участка принимаем за ноль сцены.
  const base = data[Math.floor(GRID / 2) * GRID + Math.floor(GRID / 2)];
  for (let i = 0; i < data.length; i++) data[i] -= base;

  let lo = Infinity, hi = -Infinity;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }

  return {
    grid: GRID, data,
    x0: -halfW, x1: halfW, z0: -halfH, z1: halfH,
    min: lo, max: hi, base, zoom: z, tiles: ok,
    rawRange
  };
}

/**
 * Лёгкая полировка рельефа.
 *
 * Изначально здесь стояла медианная чистка: предполагалось, что в
 * «рельеф» попадают крыши и раздувают перепад. Замер показал, что
 * срезать нечего — ни одного узла ни в Замоскворечье, ни в плотном
 * Эшампле. Причина в источнике: terrarium собран из радарной съёмки
 * с шагом 30 м, отдельные здания в ней уже усреднены, а тайлы
 * высокого зума — интерполяция тех же данных. Перепад в 42 м на
 * Эшампле оказался настоящим склоном к морю, а не застройкой.
 *
 * Поэтому осталось только сглаживание ступенек квантования: высота в
 * тайле хранится с шагом 1/256 м, и на пологих местах это давало
 * едва заметную рябь на больших плоскостях.
 */
function smooth(data, grid) {
  const src = data.slice();
  for (let j = 1; j < grid - 1; j++) {
    for (let i = 1; i < grid - 1; i++) {
      const k = j * grid + i;
      const avg = (src[k] * 4 +
        src[k - 1] + src[k + 1] + src[k - grid] + src[k + grid]) / 8;
      data[k] = src[k] * 0.4 + avg * 0.6;
    }
  }
}

/** Высота рельефа в точке (x, z) локальных метров. */
export function terrainAt(t, x, z) {
  if (!t) return 0;
  const g = t.grid;
  const u = (x - t.x0) / (t.x1 - t.x0) * (g - 1);
  const v = (z - t.z0) / (t.z1 - t.z0) * (g - 1);
  const cu = Math.max(0, Math.min(g - 1.001, u));
  const cv = Math.max(0, Math.min(g - 1.001, v));
  const i = Math.floor(cu), j = Math.floor(cv);
  const fx = cu - i, fy = cv - j;
  const d = t.data;
  return d[j * g + i] * (1 - fx) * (1 - fy) + d[j * g + i + 1] * fx * (1 - fy) +
         d[(j + 1) * g + i] * (1 - fx) * fy + d[(j + 1) * g + i + 1] * fx * fy;
}
