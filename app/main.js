/* ============================================================
   МАССИНГ — связывание карты, фонового потока, сцены и моделей.

   Шаг 1: местность — центр кликом, радиус ползунком или протяжкой.
   Шаг 2: редактор — сцена, солнце, слои, показатели, нейросеть.
   ============================================================ */

import { makeProjection, circleBBox } from './geo.js';
import { Viewer } from './scene.js';
import { sunPosition, localTime, fmtTime } from './sun.js';
import { initLiveReload, takeSnapshot } from './livereload.js';
import * as AI from './ai.js';
import * as Draw from './annotate.js';

const $ = id => document.getElementById(id);

const MIN_R = 100, MAX_R = 1200;
const WARN_R = 700;            // выше — заметная пауза на загрузке

const state = {
  pick: null,          // {lat, lon, radius}
  place: '',
  viewer: null, worker: null,
  site: null, stats: null, index: [],
  busy: false, pending: null,
  // Разметка: готовые объекты, недорисованный, помеченные здания.
  draw: {
    tool: 'none', items: [], wip: null, marks: new Set(),
    selected: null, dragging: null, ghost: null, undo: []
  }
};
// Доступ из консоли браузера: massing.viewer, massing.stats, massing.site
window.massing = state;
// Наружу же выставлена постановка участка: снимочный прогон задаёт
// место через неё, иначе проверить правку на нужном типе застройки
// можно только руками.
addEventListener('DOMContentLoaded', () => { state.setPick = setPick; });
state.setPick = (...a) => setPick(...a);

const PRESETS = [
  ['Замоскворечье', 55.7423, 37.6156, 'Москва, Замоскворечье'],
  ['Хамовники', 55.7345, 37.5891, 'Москва, Хамовники'],
  ['Le Marais', 48.8590, 2.3620, 'Париж, Ле-Маре'],
  ['Eixample', 41.3910, 2.1650, 'Барселона, Эшампле'],
  ['Midtown', 40.7540, -73.9840, 'Нью-Йорк, Мидтаун'],
  ['Shinjuku', 35.6910, 139.7000, 'Токио, Синдзюку'],
  ['Jordaan', 52.3760, 4.8790, 'Амстердам, Йордан'],
  ['Тбилиси', 41.6930, 44.8010, 'Тбилиси, Сололаки']
];

/* ============================================================
   ШАГ 1 — карта: центр кликом, радиус протяжкой
   ============================================================ */

const map = L.map('map', { zoomControl: false, boxZoom: false, doubleClickZoom: false })
  .setView([55.7512, 37.6184], 14);

// Кнопки масштаба — справа: слева их целиком закрывает панель выбора.
L.control.zoom({ position: 'topright' }).addTo(map);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap'
}).addTo(map);

map.dragging.disable();        // левая кнопка задаёт участок; карта — с Shift

const circleStyle = { color: '#b4472c', weight: 1.5, fillColor: '#b4472c', fillOpacity: 0.08 };
const dotStyle = { radius: 3, color: '#b4472c', fillColor: '#b4472c', fillOpacity: 1, weight: 0 };

let circle = null, centerDot = null, dragging = false, dragStart = null;

addEventListener('keydown', e => { if (e.key === 'Shift') map.dragging.enable(); });
addEventListener('keyup', e => { if (e.key === 'Shift') map.dragging.disable(); });

const mapEl = map.getContainer();

mapEl.addEventListener('mousedown', e => {
  if (e.button !== 0 || e.shiftKey || e.target.closest('.leaflet-control')) return;
  dragging = true;
  dragStart = map.mouseEventToLatLng(e);
  setPick(dragStart.lat, dragStart.lng, +$('radius').value);
  e.preventDefault();
});

mapEl.addEventListener('mousemove', e => {
  if (!dragging) return;
  // Протяжка от центра наружу задаёт радиус на глаз.
  const r = Math.round(dragStart.distanceTo(map.mouseEventToLatLng(e)));
  if (r < MIN_R * 0.5) return;
  const clamped = Math.max(MIN_R, Math.min(MAX_R, r));
  $('radius').value = clamped;
  setPick(dragStart.lat, dragStart.lng, clamped);
});

addEventListener('mouseup', () => { dragging = false; });

$('radius').addEventListener('input', () => {
  const r = +$('radius').value;
  $('radius-val').textContent = `${r} м`;
  if (state.pick) setPick(state.pick.lat, state.pick.lon, r);
  else $('radius-val').textContent = `${r} м`;
});

function setPick(lat, lon, radius) {
  state.pick = { lat, lon, radius };
  const ll = [lat, lon];

  if (circle) { circle.setLatLng(ll); circle.setRadius(radius); }
  else circle = L.circle(ll, { ...circleStyle, radius }).addTo(map);

  if (centerDot) centerDot.setLatLng(ll);
  else centerDot = L.circleMarker(ll, dotStyle).addTo(map);

  const area = Math.PI * radius * radius / 1e6;
  $('radius-val').textContent = `${radius} м`;
  $('ro-area').textContent = `${area.toFixed(2)} км²`;
  $('ro-size').textContent = `${radius * 2} м`;
  $('ro-center').textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

  const warn = $('area-warning');
  if (radius > WARN_R) {
    warn.hidden = false;
    warn.textContent = `Радиус ${radius} м — это ${area.toFixed(1)} км². Загрузка займёт ` +
      `до минуты, а детали застройки на общем плане сольются. Для проработки ` +
      `квартала берите 200–350 м.`;
  } else {
    warn.hidden = true;
  }
  $('build').disabled = false;
}

/* --- пресеты --- */
for (const [label, lat, lon, full] of PRESETS) {
  const btn = document.createElement('button');
  btn.className = 'chip';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    state.place = full;
    map.setView([lat, lon], 16);
    setPick(lat, lon, +$('radius').value);
  });
  $('presets').appendChild(btn);
}

/* --- геокодер --- */
async function search() {
  const q = $('search').value.trim();
  if (!q) return;
  const box = $('search-results');
  box.innerHTML = '<button disabled>Ищем…</button>';
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=6' +
                '&accept-language=ru&q=' + encodeURIComponent(q);
    const list = await (await fetch(url, { headers: { Accept: 'application/json' } })).json();
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<button disabled>Ничего не найдено</button>'; return; }
    for (const item of list) {
      const b = document.createElement('button');
      b.textContent = item.display_name;
      b.addEventListener('click', () => {
        state.place = item.display_name.split(',').slice(0, 2).join(',').trim();
        map.setView([+item.lat, +item.lon], 16);
        setPick(+item.lat, +item.lon, +$('radius').value);
        box.innerHTML = '';
      });
      box.appendChild(b);
    }
  } catch {
    box.innerHTML = '<button disabled>Геокодер недоступен</button>';
  }
}
$('search-go').addEventListener('click', search);
$('search').addEventListener('keydown', e => { if (e.key === 'Enter') search(); });


/* ============================================================
   Мелкая механика интерфейса: то, из чего складывается ощущение
   плавности. Каждая вещь по отдельности незаметна, вместе они и
   отличают инструмент, которым приятно пользоваться, от набора
   работающих элементов.
   ============================================================ */

/** Закрашивает пройденную часть дорожки ползунка. */
function syncRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  const k = max > min ? (el.value - min) / (max - min) : 0;
  el.style.setProperty('--fill', (k * 100).toFixed(2) + '%');
}
const syncAllRanges = () =>
  document.querySelectorAll('input[type=range]').forEach(syncRange);

/**
 * Смена экрана через растворение.
 *
 * Мгновенная подмена двух полноэкранных панелей читается как сбой
 * отрисовки: глаз не успевает связать то, что было, с тем, что стало.
 * Полторы десятых секунды хватает, чтобы переход прочитался движением.
 */
function swapScreen(fromId, toId, after) {
  const from = $(fromId), to = $(toId);
  if (from.hidden) { to.hidden = false; after && after(); return; }
  from.classList.add('fading');
  setTimeout(() => {
    from.hidden = true;
    from.classList.remove('fading');
    to.hidden = false;
    to.classList.add('fading');
    // Снимать прозрачность по requestAnimationFrame нельзя: в
    // неактивном окне кадры не выдаются, и экран остаётся невидимым
    // до тех пор, пока на него не переключатся. Таймер тикает всегда.
    setTimeout(() => to.classList.remove('fading'), 20);
    after && after();
  }, 180);
}

/** Прячет заслонку загрузки, дав ей раствориться. */
function hideLoader() {
  const el = $('loader');
  if (el.hidden) return;
  el.classList.add('leaving');
  setTimeout(() => { el.hidden = true; el.classList.remove('leaving'); }, 340);
}


/* ============================================================
   Разметка: линии, площадки, метки, буферы, пометки зданий

   Массинг отвечает на вопрос «что здесь стоит». Работа начинается
   со второго вопроса — «что здесь делать», и на него нужно уметь
   ответить прямо поверх модели: провести трассу, обвести участок,
   показать зону в трёхстах метрах от станции, пометить дома под
   снос. Всё это тут же считается: длина, площадь, сколько зданий
   попало и сколько в них поэтажной площади.
   ============================================================ */

const TOOL_HINT = {
  none:  'Клик по разметке выбирает её, по дому — открывает карточку. Вершины выбранного можно перетаскивать.',
  line:  'Клик — вершина, двойной клик или <kbd>Enter</kbd> — закончить, <kbd>Esc</kbd> — отменить.',
  area:  'Обведите участок кликами. Двойной клик или <kbd>Enter</kbd> замыкает контур.',
  point: 'Клик по земле ставит метку. Радиус вокруг неё задаёт ползунок буфера.',
  mark:  'Клик по дому помечает его, повторный — снимает пометку.'
};

const TOOL_KEY = { KeyV: 'none', KeyL: 'line', KeyA: 'area', KeyP: 'point', KeyM: 'mark' };

function setTool(tool) {
  const d = state.draw;
  if (d.wip) cancelWip();
  d.tool = tool;
  d.ghost = null;
  document.querySelectorAll('#draw-tool button').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  $('draw-hint').innerHTML = TOOL_HINT[tool];
  const c = state.viewer?.renderer.domElement;
  if (c) c.style.cursor = tool === 'none' ? '' : 'crosshair';
  renderDraw();
}

const bufferValue = () => +$('draw-buffer').value;

/* ---------- отмена ----------
   Разметку рисуют на глаз и промахиваются, а без отмены единственный
   выход — удалить объект целиком и начать заново. Хранится снимок
   состояния до каждого изменения; тридцати шагов хватает с запасом. */
function pushUndo() {
  const d = state.draw;
  d.undo.push(JSON.stringify({ items: d.items, marks: [...d.marks] }));
  if (d.undo.length > 30) d.undo.shift();
}

function undo() {
  const d = state.draw;
  const snap = d.undo.pop();
  if (!snap) { toast('Отменять нечего.'); return; }
  const s = JSON.parse(snap);
  d.items = s.items;
  d.marks = new Set(s.marks);
  d.wip = null;
  d.selected = null;
  renderDraw();
  refreshMarks();
}

/* ---------- выбор и правка ---------- */

function selectItem(item) {
  state.draw.selected = item ? item.id : null;
  if (item) {
    $('draw-buffer').value = item.buffer;
    $('draw-buffer-val').textContent = item.buffer + ' м';
    syncRange($('draw-buffer'));
  }
  renderDraw();
}

const selectedItem = () =>
  state.draw.items.find(it => it.id === state.draw.selected) || null;

/** Клик по сцене в режиме разметки. Возвращает true, если обработал. */
function drawClick(e) {
  const d = state.draw, v = state.viewer;

  if (d.tool === 'none') {
    // В режиме просмотра клик сначала пробует попасть в разметку:
    // она лежит на земле и по ней всё равно не выбрать здание.
    const p = v.groundPoint(e.clientX, e.clientY);
    if (p) {
      const hit = Draw.hitTest(d.items, p[0], p[2], 5);
      if (hit) { selectItem(hit); showInfo(null); v.highlight(null); return true; }
      if (d.selected) { selectItem(null); }
    }
    return false;
  }

  if (d.tool === 'mark') {
    const b = v.pick(e.clientX, e.clientY);
    if (!b) return true;
    pushUndo();
    d.marks.has(b.id) ? d.marks.delete(b.id) : d.marks.add(b.id);
    refreshMarks();
    return true;
  }

  const p = v.groundPoint(e.clientX, e.clientY);
  if (!p) return true;

  if (d.tool === 'point') {
    pushUndo();
    addItem({ kind: 'point', pts: [p], y: p[1], buffer: bufferValue() });
    return true;
  }

  if (!d.wip) d.wip = { kind: d.tool, pts: [], y: p[1], buffer: bufferValue() };
  d.wip.pts.push(p);
  renderDraw();
  return true;
}

/** Завершает недорисованный объект, если в нём хватает вершин. */
function finishWip() {
  const d = state.draw;
  if (!d.wip) return;
  const need = Draw.KINDS[d.wip.kind].min;
  const wip = d.wip;
  d.wip = null;
  d.ghost = null;
  if (wip.pts.length >= need) { pushUndo(); addItem(wip); }
  else renderDraw();
}

function cancelWip() {
  state.draw.wip = null;
  state.draw.ghost = null;
  renderDraw();
}

function addItem(item) {
  item.id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  item.name = '';
  state.draw.items.push(item);
  state.draw.selected = item.id;
  renderDraw();
}

/** Пересобирает всю разметку разом: объектов десятки, не тысячи. */
function renderDraw() {
  const d = state.draw, v = state.viewer;
  if (!v) return;
  const meshes = [];
  for (const it of d.items) meshes.push(...Draw.buildItem(it));

  const sel = selectedItem();
  if (sel) meshes.push(...Draw.vertexMarkers(sel, d.dragging?.index ?? -1));

  if (d.wip && d.wip.pts.length) {
    // Ломаная тянется за курсором: без этого не видно, куда пойдёт
    // следующий отрезок, и линию приходится набирать вслепую.
    const pts = d.ghost ? [...d.wip.pts, d.ghost] : d.wip.pts;
    meshes.push(...Draw.ghost(pts, d.wip.y, d.wip.kind));
  }
  v.setAnnotations(meshes);
  fillDrawList();
}

function fillDrawList() {
  const d = state.draw;
  const list = $('draw-list');
  if (!list) return;

  if (!d.items.length && !d.marks.size) {
    list.innerHTML = '<div class="empty">Пока ничего не размечено.</div>';
    $('draw-stats').innerHTML = '';
    return;
  }

  list.innerHTML = d.items.map(it => {
    const inside = it.buffer > 0 || it.kind === 'area'
      ? Draw.buildingsInside(it, state.index).length : 0;
    const title = it.name || Draw.KINDS[it.kind].name;
    return `<div class="draw-item${it.id === d.selected ? ' on' : ''}" data-pick="${it.id}">
      <div class="draw-item-main">
        <b>${escapeHtml(title)}</b>
        <span>${escapeHtml(Draw.describe(it))}${inside ? ` · ${inside} зд.` : ''}</span>
      </div>
      <button class="draw-ren" data-ren="${it.id}" title="Переименовать">↻</button>
      <button class="draw-del" data-del="${it.id}" title="Удалить">×</button>
    </div>`;
  }).join('');

  // Сводка по помеченным домам: ради неё пометка и нужна — сумма
  // пятна и поэтажной площади отвечает на вопрос «сколько это».
  const marked = state.index.filter(e => d.marks.has(e.b.id));
  const foot = marked.reduce((s, e) => s + (e.b.area || 0), 0);
  const floors = marked.reduce((s, e) => s + (e.b.area || 0) * (e.b.levels || Math.max(1, Math.round(e.b.h / 3))), 0);
  const row = (k, v) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`;
  $('draw-stats').innerHTML = marked.length
    ? row('Помечено домов', marked.length) +
      row('Их пятно', `${Math.round(foot).toLocaleString('ru')} м²`) +
      row('Поэтажная площадь', `${Math.round(floors).toLocaleString('ru')} м²`)
    : '';
}

function refreshMarks() {
  const d = state.draw;
  state.viewer.setMarked(state.index.filter(e => d.marks.has(e.b.id)));
  fillDrawList();
}

function clearInsolation() {
  state.insolation = null;
  if (state.viewer) state.viewer.setInsolation(null);
  const s = $('insol-stats');
  if (s) s.innerHTML = '';
  if ($('insol-legend')) $('insol-legend').hidden = true;
  if ($('insol-toggle-row')) $('insol-toggle-row').hidden = true;
  if ($('insol-run')) { $('insol-run').disabled = false; $('insol-run').textContent = 'Рассчитать за день'; }
}

function clearDraw() {
  const d = state.draw;
  if (d.items.length || d.marks.size) pushUndo();
  d.items = [];
  d.wip = null;
  d.ghost = null;
  d.selected = null;
  d.marks.clear();
  if (state.viewer) { state.viewer.setAnnotations([]); state.viewer.setMarked([]); }
  fillDrawList();
}


/**
 * Запрос строки своим полем.
 *
 * Системный prompt в оболочке выглядит чужой вставкой: другой шрифт,
 * другие кнопки, другая кнопка «ОК» — и всё оформление разом
 * рассыпается. Модальное окно у нас уже есть, ему и спрашивать.
 */
function askName(title, value = '') {
  return new Promise(resolve => {
    $('modal-body').innerHTML =
      `<h3>${escapeHtml(title)}</h3>
       <div class="form-row" style="margin-top:16px">
         <input type="text" id="ask-input" value="${escapeHtml(value)}" autocomplete="off">
       </div>
       <div class="modal-actions">
         <button class="btn-primary" id="ask-ok">Сохранить</button>
         <button class="btn-ghost" id="ask-cancel">Отмена</button>
       </div>`;
    $('modal').hidden = false;
    const input = $('ask-input');
    input.focus();
    input.select();

    const close = (val) => {
      $('modal').hidden = true;
      $('modal-body').innerHTML = '';
      resolve(val);
    };
    $('ask-ok').addEventListener('click', () => close(input.value));
    $('ask-cancel').addEventListener('click', () => close(null));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
  });
}

/* ============================================================
   Инсоляция

   Тень на выбранный час отвечает на вопрос «где тень сейчас».
   Проектировщика интересует норма: двор считается пригодным, если
   солнце стоит в нём не меньше двух часов, и это видно только по
   суммарной за день картине.
   ============================================================ */

function runInsolation() {
  if (!state.site || !state.worker) return;
  const btn = $('insol-run');
  btn.disabled = true;
  btn.textContent = 'Считаем…';
  state.worker.postMessage({
    type: 'insolation', date: $('date').value, tz: +$('tz').value
  });
}

function showInsolation(m) {
  const btn = $('insol-run');
  btn.disabled = false;
  btn.textContent = 'Пересчитать';

  if (m.empty || !m.map) { toast('Сначала соберите участок.', 'err'); return; }
  const map = m.map;
  state.insolation = map;
  state.viewer.setInsolation(map);

  const row = (k, v) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`;
  const pct = (map.share2h * 100).toFixed(0);
  $('insol-stats').innerHTML =
    row('Открытой земли', `${Math.round(map.open * map.step * map.step / 100) / 100} га`) +
    row('Из них ≥ 2 ч солнца', `${pct} %`) +
    `<div class="stat-bar"><i style="width:${pct}%"></i></div>` +
    row('В среднем', `${map.meanHours.toFixed(1)} ч`) +
    row('Разброс', `${map.minHours.toFixed(1)} — ${map.maxHours.toFixed(1)} ч`) +
    row('Расчёт занял', `${map.ms} мс`);
  $('insol-legend').hidden = false;
  $('insol-toggle-row').hidden = false;
  $('l-insol').checked = true;
  state.viewer.toggle('insol', true);
}

/* ============================================================
   Сохранённые участки

   Без этого продукт одноразовый: закрыл вкладку — и разметка,
   пометки и выбранное место пропали, а собирать участок заново
   стоит десятков секунд. Сохранение делает из инструмента рабочее
   место, куда возвращаются.
   ============================================================ */

const PROJ_KEY = 'massing.projects';

function loadProjects() {
  try { return JSON.parse(localStorage.getItem(PROJ_KEY) || '[]'); } catch { return []; }
}

function storeProjects(list) {
  try { localStorage.setItem(PROJ_KEY, JSON.stringify(list.slice(0, 40))); }
  catch { toast('Не удалось сохранить: хранилище браузера переполнено.', 'err'); }
}

async function saveProject() {
  if (!state.pick) return;
  const d = state.draw;
  const def = state.place || `${state.pick.lat.toFixed(4)}, ${state.pick.lon.toFixed(4)}`;
  const name = await askName('Название участка', def);
  if (name === null) return;

  const list = loadProjects();
  const rec = {
    id: 'p' + Date.now().toString(36),
    name: name.trim() || def,
    place: state.place,
    pick: { ...state.pick },
    terrain: $('opt-terrain').checked,
    draw: { items: d.items, marks: [...d.marks] },
    saved: new Date().toISOString()
  };
  // Одноимённый участок заменяется, а не плодится: пересохранение
  // после правки — обычное дело, и список иначе быстро зарастает.
  const at = list.findIndex(x => x.name === rec.name);
  if (at >= 0) list[at] = rec; else list.unshift(rec);
  storeProjects(list);
  fillProjects();
  toast(`Участок «${rec.name}» сохранён.`);
}

function openProject(id) {
  const rec = loadProjects().find(x => x.id === id);
  if (!rec) return;
  state.place = rec.place || rec.name;
  $('opt-terrain').checked = rec.terrain !== false;
  $('radius').value = rec.pick.radius;
  syncRange($('radius'));
  setPick(rec.pick.lat, rec.pick.lon, rec.pick.radius);
  map.setView([rec.pick.lat, rec.pick.lon], 16);
  // Разметку восстанавливаем после сборки: до неё нет ни сцены, ни
  // указателя на здания, к которым привязаны пометки.
  state.pendingDraw = rec.draw;
  run();
}

function restoreDraw() {
  const d = state.pendingDraw;
  state.pendingDraw = null;
  if (!d) return;
  state.draw.items = d.items || [];
  state.draw.marks = new Set(d.marks || []);
  renderDraw();
  refreshMarks();
}

function fillProjects() {
  const box = $('projects');
  if (!box) return;
  const list = loadProjects();
  if (!list.length) {
    box.innerHTML = '<div class="empty">Сохранённых участков пока нет.</div>';
    return;
  }
  box.innerHTML = list.map(p => {
    const n = (p.draw?.items?.length || 0) + (p.draw?.marks?.length || 0);
    const when = new Date(p.saved).toLocaleDateString('ru');
    return `<div class="proj" data-open="${p.id}">
      <div class="proj-main">
        <b>${escapeHtml(p.name)}</b>
        <span>R ${p.pick.radius} м · ${when}${n ? ` · разметки ${n}` : ''}</span>
      </div>
      <button class="draw-del" data-drop="${p.id}" title="Удалить">×</button>
    </div>`;
  }).join('');
}

/* ============================================================
   ШАГ 2 — сборка модели
   ============================================================ */

$('build').addEventListener('click', run);
$('back').addEventListener('click', () => {
  $('screen-view').classList.remove('entered');
  swapScreen('screen-view', 'screen-pick', () => map.invalidateSize());
});

let stuckTimer = null;

/* Стадии сборки — то же, чем размечены вызовы say() в worker.js.
   Полоса показывает, сколько осталось; список — из чего вообще
   складывается ожидание. Разница существенная: «68 %» не говорит
   ничего, а «сейчас качается рельеф, потом объёмы» превращает
   пустую минуту в понятную последовательность. */
const STAGES = [
  ['osm',      'Данные OpenStreetMap'],
  ['terrain',  'Рельеф местности'],
  ['parse',    'Разбор геометрии'],
  ['age',      'Возраст застройки'],
  ['volumes',  'Объёмы зданий'],
  ['surfaces', 'Покрытия и дороги'],
  ['props',    'Деревья и окружение']
];

function renderStages() {
  $('loader-stages').innerHTML =
    STAGES.map(([k, name]) => `<li data-stage="${k}">${name}</li>`).join('');
}

// Возраст известен только для Москвы, рельеф можно выключить — стадия,
// которой в этом прогоне не будет, не должна висеть неотмеченной до
// конца, иначе список выглядит недоделанным.
function setStages(skip = []) {
  renderStages();
  for (const k of skip) {
    const el = $('loader-stages').querySelector(`[data-stage="${k}"]`);
    if (el) el.remove();
  }
}

const progress = (pct, text, err = false, stage = null) => {
  // Пока ждём ответа Overpass, проценты стоят на месте по десять
  // секунд и выглядят как зависание. Бегущий блик говорит, что
  // работа идёт, не обещая при этом ложного продвижения.
  $('loader-bar').classList.toggle('wait', !err && pct > 4 && pct < 40);
  $('loader-fill').style.width = pct + '%';
  $('loader-text').textContent = text;
  $('loader-text').classList.toggle('err', err);

  if (pct >= 100 && !err) {
    for (const li of $('loader-stages').children) {
      li.classList.add('done'); li.classList.remove('now');
    }
  } else if (stage) {
    // Пройденной считается всё, что стоит выше текущей: стадии идут
    // по порядку, и возвращаться назад сборке некуда.
    const items = [...$('loader-stages').children];
    const at = items.findIndex(li => li.dataset.stage === stage);
    items.forEach((li, i) => {
      li.classList.toggle('done', at >= 0 && i < at);
      li.classList.toggle('now', i === at);
    });
  }
  if (err) showLoaderExit();
};

// Из заслонки всегда должен быть выход: если сборка споткнулась —
// на ошибке или просто застряла, — пользователь не должен остаться
// перед неподвижной надписью без единой кнопки.
function showLoaderExit() {
  $('loader-actions').hidden = false;
  clearTimeout(stuckTimer);
}

function armStuckWatchdog() {
  clearTimeout(stuckTimer);
  $('loader-actions').hidden = true;
  stuckTimer = setTimeout(() => {
    if (!$('loader').hidden) showLoaderExit();
  }, 12000);
}

$('loader-back').addEventListener('click', () => {
  clearTimeout(stuckTimer);
  hideLoader();
  swapScreen('screen-view', 'screen-pick', () => map.invalidateSize());
});
$('loader-retry').addEventListener('click', () => location.reload());

// Сбой в модулях раньше оставлял заслонку висеть на середине —
// теперь причина видна прямо на ней.
addEventListener('error', e => {
  if ($('loader').hidden) return;
  progress(100, `Сбой в коде: ${e.message}`, true);
});

function ensureWorker() {
  if (state.worker) return state.worker;
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ages') {
      state.ages = m;
      // Год постройки есть только по Москве. Вне её стадию убираем,
      // а не оставляем висеть непройденной до конца сборки.
      if (!m.covers) {
        const el = $('loader-stages').querySelector('[data-stage="age"]');
        if (el) el.remove();
      }
    }
    if (m.type === 'diag') { state.diag = m; console.log('DIAG', JSON.stringify(m)); }
    if (m.type === 'insolation') { showInsolation(m); return; }
    else if (m.type === 'cache') { state.cacheHit = m.hit; state.cacheKey = m.key; }
    else if (m.type === 'progress') progress(m.pct, m.text, false, m.stage);
    else if (m.type === 'empty') progress(100, 'В этом круге нет зданий в OSM. Выберите другое место.', true);
    else if (m.type === 'error') progress(100, m.message, true);
    else if (m.type === 'done') assemble(m);
  };
  w.onerror = (e) => progress(100, 'Сбой фонового потока: ' + e.message, true);
  state.worker = w;
  return w;
}

function run() {
  if (!state.pick) return;
  swapScreen('screen-pick', 'screen-view');
  $('loader').hidden = false;
  $('loader').classList.remove('leaving');
  setStages($('opt-terrain').checked ? [] : ['terrain']);
  progress(4, 'Готовим сцену…');
  armStuckWatchdog();

  if (!state.viewer) initViewer();
  // Разметка живёт в локальных метрах этого участка — на другом
  // участке те же координаты означают другое место.
  clearDraw();
  clearInsolation();
  state.viewer.clear();
  state.viewer.resize();
  showInfo(null);
  $('ai-clear').hidden = true;

  // Часовой пояс по долготе: даёт истинное солнечное время, которое
  // для геометрии теней важнее административного пояса.
  const tz = Math.max(-12, Math.min(14, Math.round(state.pick.lon / 15)));
  $('tz').value = tz;
  $('tz-val').textContent = `UTC${tz >= 0 ? '+' : ''}${tz}`;

  try {
    const c = map.getCenter();
    localStorage.setItem('massing.last', JSON.stringify({
      pick: state.pick, place: state.place, map: { lat: c.lat, lon: c.lng, z: map.getZoom() }
    }));
  } catch { /* приватный режим — не беда */ }

  ensureWorker().postMessage({
    type: 'build',
    site: state.pick,
    opts: { terrain: $('opt-terrain').checked }
  });
}

function assemble(m) {
  const v = state.viewer;
  state.site = m.site;
  state.stats = m.stats;
  state.fetchedAt = m.fetchedAt
    ? new Date(m.fetchedAt).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  state.index = m.buildings ? m.buildings.index : [];

  v.setSite(m.site, m.terrain);
  v.setCore(m.core);
  v.setBuildings(m.buildings);
  v.setSurface('green', m.green);
  v.setSurface('paved', m.paved);
  v.setSurface('water', m.water);
  v.setSurface('roadsSoft', m.roadsSoft);
  v.setSurface('roadsMain', m.roadsMain);
  v.setSurface('bridges', m.bridges);
  v.setProps('trees', m.trees);
  v.setProps('cars', m.cars);
  v.setProps('lamps', m.lampPosts);
  v.setSurface('fences', m.fences);

  applySun();
  applyLayers();
  fillStats(m.stats, m.terrain);

  $('view-title').textContent =
    `${state.place || 'Участок'} · R ${m.site.radius} м · ${m.stats.count} зданий` +
    (m.terrain ? ` · рельеф ${Math.round(m.terrain.max - m.terrain.min)} м` : '');

  if (state.pending) { restoreView(state.pending); state.pending = null; }

  progress(100, 'Готово');

  // Первый кадр рисуем синхронно и только потом снимаем заслонку:
  // ждать requestAnimationFrame нельзя — в неактивной вкладке кадры
  // не выдаются, и под «Готово» оставалось пустое полотно.
  v.resize();
  v.renderNow();
  hideLoader();
  clearTimeout(stuckTimer);

  // Застройка поднимается волной от центра — сборка читается как
  // действие, а не как мгновенная подмена картинки.
  if (!state.pending) v.playGrowth();
  restoreDraw();
  $('screen-view').classList.add('entered');

  // Повтор через таймеры: если размеры полотна на момент сборки ещё
  // не устоялись, картинка добьётся до правильной без участия rAF.
  setTimeout(() => { v.resize(); v.renderNow(); }, 120);
  setTimeout(() => { v.resize(); v.renderNow(); }, 600);
}

/* ============================================================
   Редактор
   ============================================================ */

function initViewer() {
  const v = new Viewer($('viewport'));
  state.viewer = v;

  let down = null;
  v.renderer.domElement.addEventListener('pointerdown', e => {
    down = [e.clientX, e.clientY];

    // Перетаскивание вершины начинается здесь: пока палец на кнопке,
    // орбиту надо отключить, иначе вместе с вершиной поедет камера.
    const sel = selectedItem();
    if (state.draw.tool === 'none' && sel) {
      const p = v.groundPoint(e.clientX, e.clientY);
      if (p) {
        const idx = Draw.nearestVertex(sel, p[0], p[2], 6);
        if (idx >= 0) {
          pushUndo();
          state.draw.dragging = { id: sel.id, index: idx };
          v.controls.enabled = false;
          renderDraw();
        }
      }
    }
  });

  v.renderer.domElement.addEventListener('pointerup', e => {
    if (state.draw.dragging) {
      state.draw.dragging = null;
      v.controls.enabled = true;
      down = null;
      renderDraw();
      return;
    }
    if (!down) return;
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
    down = null;
    if (moved > 4) return;
    if (drawClick(e)) return;              // режим разметки перехватывает клик
    const b = v.pick(e.clientX, e.clientY);
    showInfo(b);
    v.highlight(b ? b._range : null);
  });

  // Двойной клик замыкает линию или площадку. Орбита на двойной клик
  // ничего не делает, так что перехват ничего не ломает.
  v.renderer.domElement.addEventListener('dblclick', () => {
    if (state.draw.wip) finishWip();
  });

  // Подсветка под курсором: объёмы отзываются на наведение, поэтому
  // видно, что по ним можно кликнуть. Луч пускаем не чаще, чем раз
  // в 60 мс — на каждое движение мыши это было бы расточительно.
  let hoverAt = 0, drawAt = 0;
  v.renderer.domElement.addEventListener('pointermove', e => {
    const d = state.draw;

    // Вершину тащим сразу, без прореживания: рывками это выглядит
    // сломанным, а геометрия объекта крошечная.
    if (d.dragging) {
      const p = v.groundPoint(e.clientX, e.clientY);
      const it = d.items.find(x => x.id === d.dragging.id);
      if (p && it) { it.pts[d.dragging.index] = p; renderDraw(); }
      return;
    }

    // Резиновая линия за курсором.
    if (d.wip && d.wip.pts.length) {
      const now = performance.now();
      if (now - drawAt > 30) {
        drawAt = now;
        const p = v.groundPoint(e.clientX, e.clientY);
        if (p) { d.ghost = p; renderDraw(); }
      }
      return;
    }

    if (down || e.pointerType !== 'mouse') return;
    if (d.tool !== 'none' && d.tool !== 'mark') return;
    // Луч проверяет все треугольники застройки, поэтому на плотных
    // участках проверку разрежаем, а на очень плотных отключаем: там
    // подсказка под курсором не стоит просадки кадра.
    if (state.index.length > 1500) return;
    const gap = state.index.length > 500 ? 140 : 60;
    const now = performance.now();
    if (now - hoverAt < gap) return;
    hoverAt = now;
    const b = v.pick(e.clientX, e.clientY);
    v.setHover(b ? b._range : null);
    v.renderer.domElement.style.cursor = b ? 'pointer' : '';
  });
  v.renderer.domElement.addEventListener('pointerleave', () => v.setHover(null));

  v.onFrame = updateHud;
  // Если сцена не тянет, инструмент честно говорит, что он снизил.
  v.onDegrade = (text) => { const p = $('perf'); if (p) p.title = text; toast(text); };

  /* --- вкладки панели --- */
  const tabs = document.querySelectorAll('#tabs .tab');
  $('tabs').style.setProperty('--n', tabs.length);
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      if (tab.classList.contains('active')) return;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      $('tabs').style.setProperty('--i', i);      // плашка едет сюда
      document.querySelectorAll('.tab-body').forEach(b => {
        const on = b.dataset.body === tab.dataset.tab;
        b.hidden = !on;
        // Перезапуск анимации: без снятия класса второй показ той же
        // вкладки прошёл бы молча.
        b.classList.remove('enter');
        if (on) { void b.offsetWidth; b.classList.add('enter'); }
      });
    });
  });

  $('date').addEventListener('input', applySun);
  $('time').addEventListener('input', applySun);
  $('tz').addEventListener('input', applySun);

  // Плашка сегментов ездит по тому же правилу, что и у вкладок.
  const segSelect = (id, btn) => {
    const box = $(id), all = [...box.querySelectorAll('button')];
    all.forEach(b => b.classList.toggle('active', b === btn));
    box.style.setProperty('--i', all.indexOf(btn));
  };
  for (const id of ['cam-mode', 'cam-preset']) {
    const box = $(id);
    box.style.setProperty('--n', box.querySelectorAll('button').length);
    box.style.setProperty('--i', [...box.querySelectorAll('button')]
      .findIndex(b => b.classList.contains('active')));
  }
  document.querySelectorAll('#cam-mode button').forEach(btn => {
    btn.addEventListener('click', () => {
      segSelect('cam-mode', btn);
      v.setCameraMode(btn.dataset.cam);
    });
  });
  document.querySelectorAll('#cam-preset button').forEach(btn => {
    btn.addEventListener('click', () => { segSelect('cam-preset', btn); v.setView(btn.dataset.view); });
  });
  $('l-orbit').addEventListener('change', () => v.toggle('orbit', $('l-orbit').checked));
  $('replay').addEventListener('click', () => v.playGrowth());

  const layers = {
    'l-roads': 'roads', 'l-green': 'green', 'l-water': 'water', 'l-paved': 'paved',
    'l-trees': 'trees', 'l-cars': 'cars', 'l-lamps': 'lamps',
    'l-shadow': 'shadow', 'l-ao': 'ao', 'l-edges': 'edges', 'l-tilt': 'tilt'
  };
  for (const [id, name] of Object.entries(layers)) {
    $(id).addEventListener('change', () => v.toggle(name, $(id).checked));
  }
  $('l-est').addEventListener('change', () => v.setEstimatedVisible($('l-est').checked));

  $('controls-toggle').addEventListener('click', () => {
    $('controls').classList.toggle('collapsed');
    setTimeout(() => v.resize(), 300);
  });
  $('info-close').addEventListener('click', () => { showInfo(null); v.highlight(null); });

  $('exp-png').addEventListener('click', () => download(v.exportPNG(2), fname('png')));
  $('exp-obj').addEventListener('click', () => {
    download(URL.createObjectURL(new Blob([v.exportOBJ(state.site)], { type: 'text/plain' })), fname('obj'));
  });
  // Сборка GLB идёт заметное время на крупном участке: без отметки
  // на кнопке нажатие выглядит пропавшим, и по нему бьют второй раз.
  $('exp-glb').addEventListener('click', async () => {
    const btn = $('exp-glb');
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'сборка…';
    try {
      const buf = await v.exportGLB(state.site);
      download(URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' })), fname('glb'));
      toast(`Модель выгружена · ${(buf.byteLength / 1048576).toFixed(1)} МБ`);
    } catch (e) {
      toast('Не удалось собрать GLB: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  });
  $('exp-geo').addEventListener('click', exportGeoJSON);

  $('ai-setup').addEventListener('click', openAISetup);
  $('ai-render').addEventListener('click', () => guard(doRender));
  $('ai-analyze').addEventListener('click', () => guard(doAnalyze));
  $('ai-propose').addEventListener('click', () => guard(doPropose));
  $('ai-clear').addEventListener('click', () => {
    v.clearProposal();
    $('ai-clear').hidden = true;
    aiStatus('Проектные объёмы убраны.');
  });

  /* --- разметка --- */
  const toolBox = $('draw-tool');
  toolBox.style.setProperty('--n', toolBox.querySelectorAll('button').length);
  toolBox.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });
  $('draw-buffer').addEventListener('input', () => {
    $('draw-buffer-val').textContent = bufferValue() + ' м';
    // Ползунок правит выбранный объект, а без выбора — последний:
    // буфер подбирается на глаз по уже нарисованному, а не задаётся
    // вслепую заранее.
    const it = selectedItem() || state.draw.items[state.draw.items.length - 1];
    if (it) { it.buffer = bufferValue(); renderDraw(); }
  });
  $('draw-list').addEventListener('click', e => {
    const del = e.target.dataset?.del;
    if (del) {
      pushUndo();
      state.draw.items = state.draw.items.filter(it => it.id !== del);
      if (state.draw.selected === del) state.draw.selected = null;
      renderDraw();
      return;
    }
    const ren = e.target.dataset?.ren;
    if (ren) {
      const it = state.draw.items.find(x => x.id === ren);
      askName('Название объекта', it.name || Draw.KINDS[it.kind].name).then(name => {
        if (name !== null) { pushUndo(); it.name = name.trim(); renderDraw(); }
      });
      return;
    }
    const row = e.target.closest('[data-pick]');
    if (row) selectItem(state.draw.items.find(x => x.id === row.dataset.pick) || null);
  });
  $('draw-clear').addEventListener('click', clearDraw);
  $('draw-undo').addEventListener('click', undo);
  $('insol-run').addEventListener('click', runInsolation);
  $('l-insol').addEventListener('change', () => v.toggle('insol', $('l-insol').checked));
  $('save-site').addEventListener('click', saveProject);
  setTool('none');

  $('modal-close').addEventListener('click', () => { $('modal').hidden = true; });
  $('modal').addEventListener('click', e => { if (e.target.id === 'modal') $('modal').hidden = true; });
}

function applyLayers() {
  const v = state.viewer;
  v.toggle('roads', $('l-roads').checked);
  v.toggle('green', $('l-green').checked);
  v.toggle('paved', $('l-paved').checked);
  v.toggle('water', $('l-water').checked);
  v.toggle('shadow', $('l-shadow').checked);
  v.toggle('ao', $('l-ao').checked);
  v.toggle('edges', $('l-edges').checked);
  v.toggle('tilt', $('l-tilt').checked);
  v.toggle('orbit', $('l-orbit').checked);
  v.setEstimatedVisible($('l-est').checked);
}

function applySun() {
  if (!state.site) return;
  const minutes = +$('time').value;
  const tz = +$('tz').value;
  $('time-val').textContent = fmtTime(minutes);
  $('tz-val').textContent = `UTC${tz >= 0 ? '+' : ''}${tz}`;

  const when = localTime($('date').value, minutes, tz);
  const { altitude, azimuth } = sunPosition(when, state.site.lat0, state.site.lon0);
  state.viewer.setSun(altitude, azimuth);

  const altDeg = altitude * 180 / Math.PI, azDeg = azimuth * 180 / Math.PI;
  const compass = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю',
                   'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'][Math.round(azDeg / 22.5) % 16];
  $('sun-readout').innerHTML = altDeg <= 0
    ? `солнце под горизонтом (${altDeg.toFixed(1)}°)<br>сцена в сумеречном свете`
    : `высота ${altDeg.toFixed(1)}° · азимут ${azDeg.toFixed(0)}° (${compass})<br>` +
      `длина тени ≈ ${(1 / Math.tan(altitude)).toFixed(1)} × высоты`;
}

/* --- компас и масштабная линейка --- */
function updateHud() {
  const v = state.viewer, cam = v.camera, t = v.controls.target;
  const heading = Math.atan2(cam.position.x - t.x, cam.position.z - t.z);
  const rot = $('compass-rot');
  if (rot) rot.setAttribute('transform', `rotate(${(heading * 180 / Math.PI).toFixed(1)} 24 24)`);

  const h = v.renderer.domElement.clientHeight || 1;
  const mpp = cam.isOrthographicCamera
    ? (cam.top - cam.bottom) / cam.zoom / h
    : 2 * Math.tan((cam.fov * Math.PI / 180) / 2) * cam.position.distanceTo(t) / h;

  const nice = [5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  const target = mpp * 90;
  const val = nice.reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
  const line = document.querySelector('.scalebar-line');
  if (line) line.style.width = Math.max(24, Math.min(160, val / mpp)).toFixed(0) + 'px';
  $('scale-label').textContent = val >= 1000 ? `${val / 1000} км` : `${val} м`;

  const perf = $('perf');
  if (perf && v.fps) perf.textContent = `${v.fps} к/с · ${v.frameMs.toFixed(1)} мс`;
}

/* --- карточка здания --- */
function showInfo(b) {
  const card = $('info-card');
  if (!b) {
    // Уход тоже движение: карточка, исчезающая мгновенно, читается
    // как сбой, а не как закрытие.
    if (card.hidden) return;
    card.classList.add('leaving');
    setTimeout(() => { card.hidden = true; card.classList.remove('leaving'); }, 140);
    return;
  }
  card.classList.remove('leaving');
  const t = b.tags || {};
  const addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ');
  const name = addr || t.name || 'Здание без адреса в OSM';
  const kind = {
    apartments: 'многоквартирный дом', house: 'индивидуальный дом', residential: 'жилое',
    commercial: 'деловое', office: 'офисное', retail: 'торговое', industrial: 'производственное',
    school: 'школа', kindergarten: 'детский сад', university: 'вуз', hospital: 'больница',
    church: 'храм', garage: 'гараж', garages: 'гаражи', warehouse: 'склад',
    construction: 'строится', yes: 'назначение не указано'
  }[t.building] || t.building || '—';

  const row = (k, v) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`;

  /* Происхождение высоты.
     Разница между измеренным и додуманным здесь принципиальна.
     МАССИНГ достраивает то, чего нет в OSM: этажность по назначению,
     высоту этажа по эпохе, форму кровли по типу застройки. Пока
     об этом молчали, реконструкция выглядела данными — и здание,
     собранное из типового значения, ничем не отличалось от здания
     с обмеренной высотой. Теперь у каждого объёма подписано, откуда
     он взялся, а у придуманного — ещё и точность. */
  const SRC = {
    height:   ['тег height в OSM',      'ok',   '±0 м · значение задано картографом'],
    levels:   ['этажность из OSM',      'ok',   '±1–2 м · этажи заданы, высота этажа принята типовой'],
    epoch:    ['этажность OSM + эпоха', 'ok',   '±1–2 м · высота этажа взята по году постройки'],
    est:      ['оценка по тегам OSM',   'est',  '±3–5 м · ни высоты, ни этажности нет'],
    fallback: ['наша оценка по типу',   'est',  '±5 м и больше · всё, что известно, — назначение здания']
  };
  const [srcName, srcKind, srcNote] = SRC[b.src] || ['источник неизвестен', 'est', ''];

  const roof = { gabled: 'двускатная', hipped: 'вальмовая', half_hipped: 'полувальмовая',
                 pyramidal: 'шатровая', mansard: 'мансардная', gambrel: 'ломаная',
                 skillion: 'односкатная', dome: 'купол', round: 'круглая', flat: 'плоская' };
  const roofTag = t['roof:shape'];
  const roofName = roofTag ? (roof[roofTag] || roofTag)
                 : (b.epoch ? null : 'плоская');

  $('info-body').innerHTML =
    `<h4>${escapeHtml(name)}</h4>` +
    `<div class="info-sub">${escapeHtml(kind)}</div>` +
    row('Высота', `${b.h.toFixed(1)} м`) +
    (b.levels ? row('Этажей', b.levels) : '') +
    row('Пятно', `${Math.round(b.area).toLocaleString('ru')} м²`) +
    (b.year ? row('Год постройки', b.year) : (t.start_date ? row('Год', escapeHtml(t.start_date)) : '')) +
    (b.epoch ? row('Тип застройки', escapeHtml(b.epoch)) : '') +
    (roofName ? row('Кровля', escapeHtml(roofName) + (roofTag ? '' : ' (принята)')) : '') +
    (b.ground ? row('Отметка земли', `${b.ground.toFixed(1)} м`) : '') +
    `<div class="src src-${srcKind}">
       <div class="src-line"><span>Высота</span><b>${srcName}</b></div>
       ${srcNote ? `<div class="src-note">${srcNote}</div>` : ''}
     </div>` +
    // Откуда данные и на какое число. Без этого модель выглядит
    // истиной без срока годности, а OSM правят каждый день.
    `<div class="src-origin">
       Контур и теги — OpenStreetMap, ODbL${state.fetchedAt ? `, выборка ${state.fetchedAt}` : ''}.
       ${b.year ? 'Год постройки — © how-old-is-this.house, 2020, ODbL.' : ''}
     </div>`;
  card.hidden = false;
}

function fillStats(s, terrain) {
  const row = (k, v) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`;
  // Полоска под ключевыми показателями: «плотность 34 %» само по себе
  // ничего не говорит тому, кто не держит в голове типовые значения.
  // Шкала до предела, за которым квартал считается плотным, даёт
  // цифре опору — видно, много это или мало.
  const bar = (k, v, text, limit) => {
    const w = Math.max(0, Math.min(1, v / limit)) * 100;
    return `<div class="stat"><span>${k}</span><b>${text}</b></div>
            <div class="stat-bar"><i style="width:${w.toFixed(1)}%"></i></div>`;
  };
  $('stats').innerHTML =
    row('Зданий в круге', s.count.toLocaleString('ru')) +
    row('Площадь участка', `${(s.siteArea / 1e4).toFixed(1)} га`) +
    row('Пятно застройки', `${(s.footprint / 1e4).toFixed(2)} га`) +
    bar('Плотность застройки', s.coverage, `${(s.coverage * 100).toFixed(0)} %`, 0.6) +
    bar('Коэф. плотности', s.far, s.far.toFixed(2), 5) +
    row('Средняя высота', `${s.avgH.toFixed(1)} м`) +
    row('Максимум', `${s.maxH.toFixed(0)} м`) +
    (terrain ? row('Перепад рельефа', `${(terrain.max - terrain.min).toFixed(0)} м`) : '') +
    row('Высоты из OSM', `${(s.dataShare * 100).toFixed(0)} %`) +
    `<div class="stat-note">Коэффициент плотности — суммарная поэтажная площадь,
     делённая на площадь круга; этажность взята из OSM, при её отсутствии
     восстановлена из высоты. Здания на границе учтены той частью пятна,
     что попала в участок.</div>`;
}

/* ============================================================
   Экспорт
   ============================================================ */

const fname = (ext) =>
  `massing_${(state.place || 'site').replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40)}_` +
  `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;

function download(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Проектные объёмы возвращаем в WGS84, чтобы открыть в QGIS.
/**
 * Выгрузка в GeoJSON: проектные объёмы, разметка и помеченные дома.
 *
 * Всё считается в локальных метрах участка, поэтому наружу уходит
 * через обратную проекцию. Помеченные дома отдаются точкой в центре
 * пятна: контуров в облегчённой карточке здания нет, и рисовать
 * вместо них габаритный прямоугольник было бы враньём.
 */
function exportGeoJSON() {
  const items = state.viewer?.proposal || [];
  const draw = state.draw;
  const marked = state.index.filter(e => draw.marks.has(e.b.id));
  if (!items.length && !draw.items.length && !marked.length) {
    toast('Выгружать пока нечего: ни разметки, ни помеченных домов, ни проектных объёмов.', 'err');
    return;
  }
  const p = makeProjection(circleBBox(state.site.lat0, state.site.lon0, state.site.radius));
  const xy = ([x, , z]) => p.unproject(x, z);
  const features = [];

  for (const it of items) {
    features.push({
      type: 'Feature',
      properties: { role: 'проектный объём', name: it.name, levels: it.levels, height: it.height },
      geometry: {
        type: 'Polygon',
        coordinates: [[...it.polygon, it.polygon[0]].map(([x, z]) => p.unproject(x, z))]
      }
    });
  }

  for (const it of draw.items) {
    const props = { role: 'разметка', kind: Draw.KINDS[it.kind].name, buffer: it.buffer };
    if (it.kind === 'line') props.length_m = +Draw.lineLength(it.pts).toFixed(1);
    if (it.kind === 'area') props.area_m2 = +Draw.ringArea(it.pts).toFixed(1);
    features.push({
      type: 'Feature',
      properties: props,
      geometry: it.kind === 'point'
        ? { type: 'Point', coordinates: xy(it.pts[0]) }
        : it.kind === 'line'
          ? { type: 'LineString', coordinates: it.pts.map(xy) }
          : { type: 'Polygon', coordinates: [[...it.pts, it.pts[0]].map(xy)] }
    });
  }

  for (const e of marked) {
    const b = e.b;
    const cx = (b.bbox[0] + b.bbox[2]) / 2, cz = (b.bbox[1] + b.bbox[3]) / 2;
    features.push({
      type: 'Feature',
      properties: {
        role: 'помеченный дом', osm_id: b.id, height: b.h, levels: b.levels,
        area_m2: Math.round(b.area), year: b.year || null, epoch: b.epoch || null
      },
      geometry: { type: 'Point', coordinates: p.unproject(cx, cz) }
    });
  }

  const fc = { type: 'FeatureCollection', features };
  download(URL.createObjectURL(new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' })), fname('geojson'));
  toast(`Выгружено объектов: ${features.length}.`);
}

/* ============================================================
   Нейросеть
   ============================================================ */

const aiStatus = (text, err = false) => {
  const el = $('ai-status');
  el.textContent = text || '';
  el.classList.toggle('err', err);
};

async function guard(fn) {
  if (state.busy) return;
  if (!state.site) { aiStatus('Сначала постройте модель.', true); return; }
  const cfg = AI.loadConfig();
  if (!(cfg.keys?.[cfg.provider] || '').trim()) { openAISetup(); return; }
  state.busy = true;
  document.querySelectorAll('.btn-ai').forEach(b => b.disabled = true);
  try { await fn(cfg); }
  catch (e) { aiStatus(String(e.message || e), true); }
  finally {
    state.busy = false;
    document.querySelectorAll('.btn-ai').forEach(b => b.disabled = false);
  }
}

async function doRender(cfg) {
  aiStatus('Снимаем кадр…');
  const b64 = await state.viewer.frameBase64(1280);
  const url = await AI.render(cfg, b64, $('ai-style').value, $('ai-extra').value.trim(), aiStatus);
  aiStatus('Готово.');
  openModal(`
    <h3>Фотореалистичная визуализация</h3>
    <p class="modal-sub">${AI.PROVIDERS[cfg.provider].label} · ${AI.modelFor(cfg, 'image')}</p>
    <img class="modal-img" src="${url}" alt="Визуализация участка">
    <div class="modal-actions"><button class="btn-primary" id="modal-save">Сохранить PNG</button></div>
  `);
  $('modal-save').addEventListener('click', () => download(url, fname('ai.png')));
}

async function doAnalyze(cfg) {
  aiStatus('Снимаем кадр…');
  const b64 = await state.viewer.frameBase64(1100);
  const text = await AI.analyze(cfg, b64, state.place, state.stats, $('ai-extra').value.trim(), aiStatus);
  aiStatus('Готово.');
  openModal(`
    <h3>Аналитическая записка</h3>
    <p class="modal-sub">${AI.PROVIDERS[cfg.provider].label} · ${AI.modelFor(cfg, 'text')}</p>
    <div class="modal-text">${mdToHtml(text)}</div>
    <div class="modal-actions"><button class="btn-primary" id="modal-save">Сохранить Markdown</button></div>
  `);
  $('modal-save').addEventListener('click', () => {
    download(URL.createObjectURL(new Blob([text], { type: 'text/markdown' })), fname('md'));
  });
}

async function doPropose(cfg) {
  const brief = $('ai-extra').value.trim();
  if (!brief) { aiStatus('Опишите задание в поле «Задание или уточнение».', true); return; }

  // Габариты существующих пятен: список длинный, отдаём модели только
  // крупнейшие — мелкие сараи погоды не делают.
  const occupied = state.index
    .map(e => e.b.bbox).filter(Boolean)
    .sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))
    .slice(0, 120)
    .map(b => b.join(' ')).join('; ');

  const res = await AI.propose(cfg, brief, state.site, state.stats, occupied, aiStatus);
  const n = state.viewer.addProposal(res.buildings);
  $('ai-clear').hidden = n === 0;
  aiStatus(`Размещено объёмов: ${n}.`);
  openModal(`
    <h3>Проектные объёмы</h3>
    <p class="modal-sub">${AI.PROVIDERS[cfg.provider].label} · ${AI.modelFor(cfg, 'text')} · размещено ${n}</p>
    <div class="modal-text"><p>${escapeHtml(res.reasoning || '')}</p>
    <ul>${res.buildings.map(b => `<li>${escapeHtml(b.name)} — ${b.levels} эт., ${(+b.height).toFixed(1)} м</li>`).join('')}</ul></div>
    <div class="modal-actions"><button class="btn-primary" id="modal-save">Выгрузить GeoJSON</button></div>
  `);
  $('modal-save').addEventListener('click', exportGeoJSON);
}

/* --- настройки провайдера --- */
function openAISetup() {
  const cfg = AI.loadConfig();
  const opts = Object.entries(AI.PROVIDERS)
    .map(([k, p]) => `<option value="${k}" ${k === cfg.provider ? 'selected' : ''}>${p.label}</option>`).join('');

  openModal(`
    <h3>Доступ к нейросети</h3>
    <p class="modal-sub">Ключ хранится только в этом браузере и уходит напрямую провайдеру.</p>
    <div class="form-row">
      <label for="cfg-provider">Провайдер</label>
      <select id="cfg-provider">${opts}</select>
    </div>
    <div class="form-row">
      <label for="cfg-key">API-ключ</label>
      <input type="password" id="cfg-key" placeholder="">
    </div>
    <div class="form-row">
      <label for="cfg-mt">Модель для текста и объёмов</label>
      <input type="text" id="cfg-mt">
    </div>
    <div class="form-row">
      <label for="cfg-mi">Модель для изображений</label>
      <input type="text" id="cfg-mi">
    </div>
    <p class="modal-note" id="cfg-note"></p>
    <p class="modal-note warn">Запросы уходят с вашего ключа и оплачиваются по тарифу
      провайдера. Заводите отдельный ключ с лимитом: страница исполняет сторонний код
      (карты, three.js), и ключ в браузере в принципе доступен расширениям.</p>
    <div class="modal-actions"><button class="btn-primary" id="cfg-save">Сохранить</button></div>
  `);

  const fill = () => {
    const p = AI.PROVIDERS[$('cfg-provider').value];
    const cur = { ...cfg, provider: $('cfg-provider').value };
    $('cfg-key').placeholder = p.keyHint;
    $('cfg-key').value = cfg.keys?.[cur.provider] || '';
    $('cfg-mt').value = AI.modelFor(cur, 'text') || '';
    $('cfg-mi').value = AI.modelFor(cur, 'image') || '';
    $('cfg-mt').disabled = !p.models.text;
    $('cfg-mi').disabled = !p.models.image;
    $('cfg-note').textContent = p.note;
  };
  $('cfg-provider').addEventListener('change', fill);
  fill();

  $('cfg-save').addEventListener('click', () => {
    const provider = $('cfg-provider').value;
    const next = AI.loadConfig();
    next.provider = provider;
    next.keys = { ...next.keys, [provider]: $('cfg-key').value.trim() };
    next.models = { ...next.models, [provider]: { text: $('cfg-mt').value.trim(), image: $('cfg-mi').value.trim() } };
    AI.saveConfig(next);
    $('modal').hidden = true;
    aiStatus(`Провайдер: ${AI.PROVIDERS[provider].label}.`);
  });
}

function openModal(html) {
  $('modal-body').innerHTML = html;
  $('modal').hidden = false;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Достаточно для ответа модели: заголовки, списки, жирный, абзацы.
function mdToHtml(md) {
  const lines = escapeHtml(md).split('\n');
  let html = '', inList = false;
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^#{1,3}\s/.test(l)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h4>${l.replace(/^#{1,3}\s/, '')}</h4>`;
    } else if (/^[-*]\s/.test(l)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${bold(l.replace(/^[-*]\s/, ''))}</li>`;
    } else if (!l.trim()) {
      if (inList) { html += '</ul>'; inList = false; }
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${bold(l)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}
const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

/* ============================================================
   Живая перезагрузка: снимок состояния и его восстановление
   ============================================================ */

const LAYER_IDS = ['l-roads', 'l-green', 'l-water', 'l-paved', 'l-edges', 'l-shadow', 'l-ao', 'l-tilt', 'l-est', 'l-orbit'];

function snapshot() {
  const v = state.viewer;
  const c = map.getCenter();
  return {
    busy: state.busy,
    pick: state.pick,
    place: state.place,
    onView: !$('screen-view').hidden,
    terrain: $('opt-terrain').checked,
    date: $('date').value, time: $('time').value, tz: $('tz').value,
    aiExtra: $('ai-extra').value, aiStyle: $('ai-style').value,
    tab: document.querySelector('#tabs .tab.active')?.dataset.tab,
    camMode: document.querySelector('#cam-mode button.active')?.dataset.cam || 'persp',
    cam: v ? [...v.camera.position.toArray(), ...v.controls.target.toArray()] : null,
    zoom: v?.camera.isOrthographicCamera ? v.camera.zoom : null,
    layers: Object.fromEntries(LAYER_IDS.map(id => [id, $(id).checked])),
    proposal: v?.proposal || [],
    map: { lat: c.lat, lon: c.lng, z: map.getZoom() }
  };
}

function applySnapshot(s) {
  if (s.map) map.setView([s.map.lat, s.map.lon], s.map.z);
  state.place = s.place || '';
  $('opt-terrain').checked = s.terrain !== false;
  for (const [id, on] of Object.entries(s.layers || {})) if ($(id)) $(id).checked = on;
  if (s.date) $('date').value = s.date;
  if (s.time) $('time').value = s.time;
  if (s.tz) $('tz').value = s.tz;
  $('ai-extra').value = s.aiExtra || '';
  if (s.aiStyle) $('ai-style').value = s.aiStyle;

  if (!s.pick) return;
  $('radius').value = s.pick.radius;
  setPick(s.pick.lat, s.pick.lon, s.pick.radius);

  if (s.onView) { state.pending = s; run(); }
}

function restoreView(s) {
  const v = state.viewer;
  if (s.tab) document.querySelector(`#tabs .tab[data-tab="${s.tab}"]`)?.click();
  if (s.camMode === 'ortho') {
    document.querySelectorAll('#cam-mode button').forEach(b => b.classList.toggle('active', b.dataset.cam === 'ortho'));
    v.setCameraMode('ortho');
    if (s.zoom) { v.camera.zoom = s.zoom; v.camera.updateProjectionMatrix(); }
  }
  if (s.cam && s.cam.length === 6) {
    v.tween = null;
    v.camera.position.set(s.cam[0], s.cam[1], s.cam[2]);
    v.controls.target.set(s.cam[3], s.cam[4], s.cam[5]);
    v.controls.update();
  }
  if (s.proposal?.length) {
    v.addProposal(s.proposal);
    $('ai-clear').hidden = false;
  }
  v.needsRender = true;
}

/* --- первый запуск: сразу показать, что инструмент делает --- */
function firstVisit() {
  const [label, lat, lon, full] = PRESETS[0];
  state.place = full;
  map.setView([lat, lon], 16);
  setPick(lat, lon, 250);
  $('hint').innerHTML =
    `<strong>Участок уже намечен</strong> — ${label}, радиус 250 м. Нажмите
     «Открыть в редакторе», чтобы увидеть, как это работает. Дальше ставьте
     центр кликом по карте и тяните от него, чтобы задать радиус.`;
}

const restored = takeSnapshot();
if (restored) {
  applySnapshot(restored);
} else {
  let last = null;
  try { last = JSON.parse(localStorage.getItem('massing.last') || 'null'); } catch { /* пусто */ }
  if (last?.pick) applySnapshot({ ...last, onView: false, layers: {} });
  else firstVisit();
}
/* --- всплывающие сообщения ---
   Сообщение о том, что сцена не тянет и качество снижено, раньше
   уходило в строку статуса на вкладке нейросети — то есть в никуда,
   если пользователь на ней не стоял. Плашка находит его сама и
   уходит через несколько секунд. */
let toastTimer = null;
function toast(text, kind = '') {
  const el = $('toast');
  if (!el || !text) return;
  el.textContent = text;
  el.className = 'toast on ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 4200);
}

/* --- сворачиваемые разделы панели ---
   Состояние переживает перезагрузку: раз пользователь свернул солнце,
   значит оно ему сейчас не нужно, и открывать его обратно при каждом
   запуске — навязчиво. */
const GROUPS_KEY = 'massing.groups';
let closedGroups = new Set();
try { closedGroups = new Set(JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]')); } catch { /* пусто */ }

document.querySelectorAll('.ctl-group[data-group]').forEach(g => {
  const name = g.dataset.group;
  if (closedGroups.has(name)) g.classList.add('closed');
  const head = g.querySelector('.ctl-head');
  if (!head) return;
  head.setAttribute('aria-expanded', String(!g.classList.contains('closed')));
  head.addEventListener('click', () => {
    const closed = g.classList.toggle('closed');
    head.setAttribute('aria-expanded', String(!closed));
    closed ? closedGroups.add(name) : closedGroups.delete(name);
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify([...closedGroups])); } catch { /* пусто */ }
  });
});

/* --- заполнение дорожек ползунков --- */
syncAllRanges();
document.addEventListener('input', e => {
  if (e.target.type === 'range') syncRange(e.target);
});

/* --- клавиши ---
   Виды, рост застройки и панель — то, к чему возвращаешься чаще
   всего. Подсказка всплывает на первой же попытке и уходит сама,
   чтобы не занимать угол постоянно. */
addEventListener('keydown', e => {
  if ($('screen-view').hidden) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const v = state.viewer;
  if (!v) return;

  // Инструменты — по коду клавиши, а не по символу: на русской
  // раскладке e.key вернул бы «в» вместо «v», и горячие клавиши
  // работали бы через раз.
  if (TOOL_KEY[e.code] && !e.metaKey && !e.ctrlKey) {
    document.querySelector('#tabs .tab[data-tab="draw"]')?.click();
    setTool(TOOL_KEY[e.code]);
    showKeyhint();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const sel = selectedItem();
    if (sel) {
      e.preventDefault();
      pushUndo();
      state.draw.items = state.draw.items.filter(it => it.id !== sel.id);
      state.draw.selected = null;
      renderDraw();
      return;
    }
  }

  const views = { '1': 'iso', '2': 'top', '3': 'eye' };
  if (views[e.key]) {
    document.querySelector(`#cam-preset button[data-view="${views[e.key]}"]`)?.click();
  } else if (e.code === 'Space') {
    e.preventDefault(); $('replay').click();
  } else if (e.key === 'Tab') {
    e.preventDefault(); $('controls-toggle').click();
  } else if (e.key === 'Enter') {
    if (state.draw.wip) { e.preventDefault(); finishWip(); } else return;
  } else if (e.key === 'Escape') {
    if (!$('modal').hidden) $('modal-close').click();
    else if (state.draw.wip) cancelWip();
    else if (state.draw.tool !== 'none') setTool('none');
    else if (state.draw.selected) selectItem(null);
    else { showInfo(null); v.highlight(null); }
  } else return;

  showKeyhint();
});

let keyhintTimer = null;
function showKeyhint() {
  const el = $('keyhint');
  if (!el) return;
  el.classList.add('on');
  clearTimeout(keyhintTimer);
  keyhintTimer = setTimeout(() => el.classList.remove('on'), 2600);
}

/* --- сохранённые участки --- */
fillProjects();
$('projects').addEventListener('click', e => {
  const drop = e.target.dataset?.drop;
  if (drop) {
    storeProjects(loadProjects().filter(x => x.id !== drop));
    fillProjects();
    return;
  }
  const row = e.target.closest('[data-open]');
  if (row) openProject(row.dataset.open);
});

initLiveReload(snapshot);
