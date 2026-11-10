/* ============================================================
   Кэш ответов Overpass в IndexedDB.

   Повторное открытие того же участка не должно снова ждать
   общедоступный сервер: он медленный и часто перегружен.
   Работает и в главном потоке, и в воркере.
   ============================================================ */

const DB = 'massing-cache';
const STORE = 'overpass';
const TTL = 7 * 24 * 3600 * 1000;      // неделя: OSM меняется медленнее
const MAX_ENTRIES = 40;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const cacheKey = (b) =>
  [b.south, b.west, b.north, b.east].map(v => v.toFixed(5)).join(',');

const parseKey = (key) => {
  const [south, west, north, east] = key.split(',').map(Number);
  return { south, west, north, east };
};

const area = (b) => (b.north - b.south) * (b.east - b.west);
const covers = (outer, inner) =>
  outer.south <= inner.south + 1e-9 && outer.north >= inner.north - 1e-9 &&
  outer.west <= inner.west + 1e-9 && outer.east >= inner.east - 1e-9;

/**
 * Ищет данные для участка — сначала точное совпадение, затем любую
 * сохранённую выборку, которая целиком накрывает запрошенную область.
 *
 * Сдвинул центр на десяток метров или уменьшил радиус — область почти
 * та же, но ключ уже другой, и раньше это означало новый запрос к
 * Overpass на десятки секунд. Лишние объекты по краям всё равно
 * отсекаются обрезкой по кругу, поэтому большая выборка подходит.
 * Слишком большие не берём: тянуть мегабайты ради маленького круга
 * дороже, чем спросить заново.
 *
 * @returns {{elements:Array, ts:number}|null} вместе с данными отдаём
 *   время выборки: карточка здания подписывает, на какое число взяты
 *   контуры, а из кэша они могут быть недельной давности.
 */
export async function cacheGet(bbox) {
  const key = typeof bbox === 'string' ? bbox : cacheKey(bbox);
  const want = typeof bbox === 'string' ? parseKey(bbox) : bbox;

  try {
    const db = await open();
    const store = db.transaction(STORE).objectStore(STORE);

    const exact = await new Promise((resolve) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (exact && Date.now() - exact.ts <= TTL) return { elements: exact.data, ts: exact.ts };

    const keys = await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });

    const wantArea = area(want);
    const fit = keys
      .map(k => ({ k, b: parseKey(k) }))
      .filter(({ b }) => covers(b, want) && area(b) <= wantArea * 4)
      .sort((a, b) => area(a.b) - area(b.b))[0];
    if (!fit) return null;

    const rec = await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(fit.k);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (!rec || Date.now() - rec.ts > TTL) return null;
    return { elements: rec.data, ts: rec.ts };
  } catch { return null; }
}

export async function cachePut(key, data) {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key, ts: Date.now(), data });
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    await trim(db);
  } catch { /* кэш необязателен — молча продолжаем */ }
}

// Держим базу небольшой: участки крупных городов весят мегабайты.
async function trim(db) {
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const all = await new Promise(res => {
    const req = store.getAllKeys();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => res([]);
  });
  if (all.length <= MAX_ENTRIES) return;
  const recs = await new Promise(res => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => res([]);
  });
  recs.sort((a, b) => a.ts - b.ts)
      .slice(0, recs.length - MAX_ENTRIES)
      .forEach(r => store.delete(r.key));
}
