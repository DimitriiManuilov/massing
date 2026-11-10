/* ============================================================
   МАССИНГ — десктопная оболочка.

   Веб-версия целиком переезжает внутрь окна: тот же код, те же
   данные. Файлы отдаются через собственную схему app://, а не
   через file:// и не через локальный сервер — на это есть три
   причины:

     • ES-модули и веб-воркеры требуют настоящего origin,
       через file:// они не загружаются;
     • origin у app://massing постоянный, поэтому кэш участков
       в IndexedDB переживает перезапуск приложения (у локального
       сервера порт мог смениться и кэш терялся бы);
     • не нужно держать открытый порт на машине пользователя.
   ============================================================ */

const { app, BrowserWindow, Menu, protocol, net, session, shell, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'app://massing';

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  }
}]);

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f6f5f2',
    titleBarStyle: 'hiddenInset',
    title: 'МАССИНГ',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Данные OSM и тайлы высот приходят со сторонних доменов;
      // страница исполняет только собственный код.
      webSecurity: true
    }
  });

  win.loadURL(`${ORIGIN}/index.html`);

  // Внешние ссылки уходят в системный браузер, а не подменяют окно.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Ошибки страницы видны в терминале: внутри приложения нет адресной
  // строки, и без этого сбой в модуле выглядел бы просто пустым окном.
  // Сигнатура события менялась между версиями Electron: раньше
  // аргументы приходили списком, теперь объектом. Поддерживаем оба —
  // без этого ошибки страницы уходили в пустоту.
  win.webContents.on('console-message', (...args) => {
    const d = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null;
    const level = d ? d.level : args[1];
    const message = d ? d.message : args[2];
    const bad = level === 'error' || level === 'warning' || (typeof level === 'number' && level >= 2);
    if (bad) console.error('[страница]', message);
  });

  if (process.env.MASSING_SELFTEST) win.webContents.once('did-finish-load', selfTest);
  if (process.env.MASSING_SHOTS) win.webContents.once('did-finish-load', captureGrowth);
  if (process.env.MASSING_DRAWTEST) win.webContents.once('did-finish-load', drawTest);
  if (process.env.MASSING_GLB) win.webContents.once('did-finish-load', dumpGLB);

  win.on('closed', () => { win = null; });
}

/* Самопроверка: собирает участок и сообщает, дошло ли дело до сцены.
   Запуск: MASSING_SELFTEST=1 npm start */
async function selfTest() {
  const preset = Number(process.env.MASSING_PRESET || 0);
  const script = `(async () => {
    const process_preset = ${preset};
    const $ = id => document.getElementById(id);
    const errs = [];
    addEventListener('error', e => errs.push(String(e.message) + ' @ ' + String((e.error && e.error.stack) || '').slice(0, 180)));
    await new Promise(r => setTimeout(r, 1200));
    if (!window.massing) return { ok: false, why: 'модуль не загрузился' };
    // Участок задаём явно: иначе тест берёт последнее место из прошлой
    // сессии, а оно может оказаться пустым или крошечным.
    if (!$('screen-pick').hidden) {
      document.querySelectorAll('.chip')[Number(process_preset)].click();
      $('radius').value = 250;
      $('radius').dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 300));
    }
    $('build').click();
    // Публичный Overpass под нагрузкой отвечает и минуту; у приложения
    // свой кэш, при первом запуске он пуст. По дороге печатаем стадию —
    // молчащий тест не даёт понять, на чём именно он встал.
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 500));
      if ($('loader').hidden) break;
      if (i % 20 === 0) console.warn('[самопроверка] ' + $('loader-text').textContent);
    }
    const v = window.massing.viewer;
    const geo = v && v.buildingMesh && v.buildingMesh.geometry;
    if (!v || !v.buildingMesh) {
      return { ok: false, why: 'сцена не собралась', status: $('loader-text').textContent, errs };
    }

    const gl = v.renderer.getContext();
    const px = new Uint8Array(4);
    // Честный замер: в фоне команды GPU копятся в очереди, и без
    // чтения пикселя измерялась бы не работа, а её планирование.
    const bench = (n) => {
      v.needsRender = true; v.renderNow();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        v.needsRender = true; v.renderNow();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return +((performance.now() - t0) / n).toFixed(2);
    };

    const steps = {};
    v.growth = null; v.grow.value = 1;             // ждать анимацию незачем
    v.setQuality(true);

    for (const view of ['iso', 'top', 'eye']) {
      v.setView(view, 0);
      steps['вид ' + view] = bench(10);
    }
    v.setView('iso', 0);

    v.setCameraMode('ortho'); steps['аксонометрия'] = bench(6);
    v.setCameraMode('persp');

    for (const id of ['l-roads', 'l-green', 'l-water', 'l-edges', 'l-shadow', 'l-ao', 'l-tilt', 'l-est']) {
      const el = $(id);
      el.checked = !el.checked; el.dispatchEvent(new Event('change'));
      el.checked = !el.checked; el.dispatchEvent(new Event('change'));
    }
    steps['все слои'] = bench(8);

    // выбор здания по центру кадра
    const r = v.renderer.domElement.getBoundingClientRect();
    const picked = v.pick(r.left + r.width * 0.42, r.top + r.height * 0.55);

    // Кэш проверяем напрямую: вторая полная сборка стоила бы ещё
    // одного похода к Overpass и растягивала тест на минуты.
    let cache = 'не проверялся';
    try {
      const [{ cacheGet }, { circleBBox }] = await Promise.all([
        import('./app/cache.js'), import('./app/geo.js')
      ]);
      const p = window.massing.pick;
      const t1 = performance.now();
      const hit = await cacheGet(circleBBox(p.lat, p.lon, p.radius));
      cache = hit
        ? 'есть, ' + hit.elements.length + ' объектов за ' + Math.round(performance.now() - t1) + ' мс'
        : 'промах';
    } catch (e) { cache = 'ошибка: ' + e.message; }

    // Выгрузку проверяем на самой модели: собрать GLB — единственный
    // способ убедиться, что все слои сцены годятся для экспортёра.
    // Ошибка здесь всплывает только на реальной геометрии.
    let glb = 'не проверялся';
    try {
      const t2 = performance.now();
      const buf = await v.exportGLB(window.massing.site || null);
      const names = v.exportScene().children.map(g => g.name);
      glb = (buf.byteLength / 1048576).toFixed(2) + ' МБ за ' +
            Math.round(performance.now() - t2) + ' мс, слои: ' + names.join(', ');
    } catch (e) { glb = 'ошибка: ' + e.message; }

    return {
      ok: !!(v.buildingMesh) && errs.length === 0,
      errs,
      title: $('view-title').textContent,
      buildings: window.massing.stats && window.massing.stats.count,
      growAttrs: geo ? ['aBottom', 'aDelay'].every(a => !!geo.attributes[a]) : false,
      entered: $('screen-view').classList.contains('entered'),
      picked: picked ? (picked.tags['addr:street'] || picked.tags.building || 'да') : 'мимо',
      msPerFrame: steps,
      кэш: cache,
      glb,
      стадии: [...document.getElementById('loader-stages').children]
        .filter(li => li.classList.contains('done')).length + ' из ' +
        document.getElementById('loader-stages').children.length,
      возраст: JSON.stringify(window.massing.ages || null),
      рельеф: (() => {
        const tr = v.terrain;
        if (!tr) return 'выключен';
        return 'перепад ' + (tr.max - tr.min).toFixed(0) + ' м';
      })()
    };
  })()`;
  // Жёсткий срок: если страница зависла, тест обязан сказать об этом,
  // а не молчать до бесконечности.
  const deadline = new Promise(r =>
    setTimeout(() => r({ ok: false, why: 'самопроверка не уложилась в 180 с' }), 180000));
  try {
    const res = await Promise.race([win.webContents.executeJavaScript(script), deadline]);
    console.log('SELFTEST ' + JSON.stringify(res));
  } catch (e) {
    console.log('SELFTEST ' + JSON.stringify({ ok: false, why: String(e.message || e) }));
  }
}

/* Источники, которым разрешено отвечать нашему окну.
   Origin у приложения — app://massing, нестандартная схема, и часть
   сервисов (Overpass в первую очередь) не возвращает на неё заголовок
   Access-Control-Allow-Origin. В браузере всё работало, потому что там
   origin был http://localhost. Дописываем заголовок сами — но только
   для перечисленных доменов, а не для всего подряд. */
const ALLOWED_HOSTS = [
  'https://maps.mail.ru/*',
  'https://overpass.osm.ch/*',
  'https://overpass-api.de/*',
  'https://overpass.kumi.systems/*',
  'https://s3.amazonaws.com/*',
  'https://nominatim.openstreetmap.org/*',
  'https://tile.openstreetmap.org/*',
  'https://api.anthropic.com/*',
  'https://generativelanguage.googleapis.com/*',
  'https://api.openai.com/*',
  'https://fal.run/*',
];

function relaxCors() {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ALLOWED_HOSTS },
    (details, callback) => {
      const headers = { ...details.responseHeaders };

      // Часть сервисов (Mapillary) уже отдаёт разрешение сама. Если
      // просто дописать своё, в ответе окажутся два заголовка, браузер
      // увидит «*, *» и отвергнет ответ целиком. Поэтому сначала
      // вычищаем имеющиеся варианты в любом регистре, потом ставим один.
      const drop = /^access-control-allow-(origin|headers|methods)$/i;
      for (const name of Object.keys(headers)) {
        if (drop.test(name)) delete headers[name];
      }
      headers['Access-Control-Allow-Origin'] = ['*'];
      headers['Access-Control-Allow-Headers'] = ['*'];
      headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
      callback({ responseHeaders: headers });
    }
  );
}

function serveFiles() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (!rel || rel === '/') rel = '/index.html';

    // Не выпускаем запросы за пределы папки приложения.
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function buildMenu() {
  const template = [
    {
      label: 'МАССИНГ',
      submenu: [
        { role: 'about', label: 'О программе' },
        { type: 'separator' },
        { role: 'hide', label: 'Скрыть' },
        { role: 'hideOthers', label: 'Скрыть остальные' },
        { type: 'separator' },
        { role: 'quit', label: 'Выйти' }
      ]
    },
    {
      label: 'Файл',
      submenu: [
        {
          label: 'Новый участок',
          accelerator: 'CmdOrCtrl+N',
          click: () => win?.webContents.executeJavaScript(
            'document.getElementById("back")?.click()'
          )
        },
        {
          label: 'Сохранить кадр…',
          accelerator: 'CmdOrCtrl+S',
          click: () => win?.webContents.executeJavaScript(
            'document.getElementById("exp-png")?.click()'
          )
        },
        { type: 'separator' },
        {
          label: 'О проекте',
          click: () => win?.loadURL(`${ORIGIN}/case.html`)
        }
      ]
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выбрать всё' }
      ]
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Обновить' },
        { role: 'togglefullscreen', label: 'Во весь экран' },
        { type: 'separator' },
        { role: 'zoomIn', label: 'Крупнее' },
        { role: 'zoomOut', label: 'Мельче' },
        { role: 'resetZoom', label: 'Обычный размер' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' }
      ]
    },
    {
      label: 'Справка',
      submenu: [
        {
          label: 'Данные и лицензии',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: 'Источники данных',
            message: 'МАССИНГ',
            detail: 'Застройка, улицы, вода и озеленение — OpenStreetMap (ODbL).\n' +
                    'Рельеф — AWS Terrain Tiles.\n' +
                    'Поиск мест — Nominatim.\n\n' +
                    'Запросы к нейросетям уходят напрямую выбранному провайдеру ' +
                    'с ключом, сохранённым в этом приложении.'
          })
        },
        {
          label: 'Открыть OpenStreetMap',
          click: () => shell.openExternal('https://www.openstreetmap.org/')
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* Снимает несколько кадров подъёма застройки: анимацию иначе
   не показать статикой. Запуск: MASSING_SHOTS=1 npm start */
async function captureGrowth() {
  const fs = require('node:fs/promises');
  const out = path.join(ROOT, 'examples');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // Место снимка можно задать снаружи: MASSING_SHOT_SITE="55.67,37.56,300".
  // Нужно, чтобы проверять правки на конкретном типе застройки —
  // серийные секции в Замоскворечье не встречаются вовсе.
  const site = (process.env.MASSING_SHOT_SITE || '').split(',').map(Number);
  const custom = site.length === 3 && site.every(Number.isFinite) ? site : null;

  // Экран выбора снимается до сборки: иначе его вообще не увидеть,
  // а половина работы над оформлением приходится на него.
  await win.webContents.executeJavaScript(
    `new Promise(r => setTimeout(r, 1400))`);
  await fs.writeFile(path.join(out, 'screen_pick.png'), (await win.webContents.capturePage()).toPNG());
  console.log('SHOT screen_pick');

  await win.webContents.executeJavaScript(`(async () => {
    const $ = id => document.getElementById(id);
    const custom = ${JSON.stringify(custom)};
    await new Promise(r => setTimeout(r, 1200));
    // Снимки должны быть сравнимы между запусками, поэтому место и
    // радиус задаются явно, а не берутся из прошлой сессии.
    if (!$('screen-pick').hidden) {
      if (custom) {
        // Подпись иначе осталась бы от прошлой сессии и врала бы
        // про место, которое на самом деле сменили.
        window.massing.place = 'Проверочный участок';
        window.massing.setPick
          ? window.massing.setPick(custom[0], custom[1], custom[2])
          : document.querySelectorAll('.chip')[0].click();
        $('radius').value = custom[2];
        $('radius').dispatchEvent(new Event('input'));
      } else {
        document.querySelectorAll('.chip')[0].click();
        $('radius').value = 250;
        $('radius').dispatchEvent(new Event('input'));
      }
      await new Promise(r => setTimeout(r, 300));
    }
    $('build').click();
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 500));
      if ($('loader').hidden) break;
    }
    const v = window.massing.viewer;
    v.setView(window.__SHOT_VIEW || 'iso', 0);
    v.playGrowth(2600);
    return JSON.stringify({ diag: window.massing.diag || null, ages: window.massing.ages || null });
  })()`).then(r => console.log('SHOT-DIAG ' + r)).catch(() => {});

  // Последний кадр снимается заведомо после конца анимации: три
  // предыдущих ловят подъём, а четвёртый нужен готовым — по нему
  // проверяются кровли, карнизы и членение фасадов.
  for (const [ms, name] of [[420, 'grow_1'], [480, 'grow_2'], [480, 'grow_3'], [3400, 'final']]) {
    await wait(ms);
    // Снимок фонового окна отдаёт прежний композит: один вызов
    // capturePage возвращал кадр экрана выбора для всех четырёх
    // снимков подряд, хотя сцена давно собралась. Помогает только
    // явная перерисовка и холостой снимок перед настоящим.
    await win.webContents.executeJavaScript('window.massing.viewer.renderNow(), true').catch(() => {});
    await win.webContents.capturePage();
    const img = await win.webContents.capturePage();
    await fs.writeFile(path.join(out, `${name}.png`), img.toPNG());
    console.log('SHOT ' + name);
  }

  // Карта инсоляции: её тоже надо видеть глазами, а не только в цифрах.
  await win.webContents.executeJavaScript(`(async () => {
    const $ = id => document.getElementById(id);
    document.querySelector('#tabs .tab[data-tab="site"]').click();
    $('insol-run').click();
    for (let i = 0; i < 100 && !window.massing.insolation; i++)
      await new Promise(r => setTimeout(r, 200));
    window.massing.viewer.setView('top', 0);
    await new Promise(r => setTimeout(r, 600));
    window.massing.viewer.renderNow();
    return JSON.stringify({ ins: !!window.massing.insolation,
                            meshes: window.massing.viewer.groups.insol.children.length });
  })()`).then(r => console.log('SHOT-INSOL ' + r))
        .catch(e => console.log('SHOT-INSOL-ERR ' + String(e).slice(0, 300)));
  // Первый снимок после смены вида отдаёт прежний композит: окно в
  // фоне не перерисовывается по требованию. Дёргаем кадр и берём
  // второй снимок.
  // Снимок после смены вида отдаёт прежний композит: окно в фоне не
  // перерисовывается по требованию. Дёргаем кадр несколько раз.
  for (let i = 0; i < 4; i++) {
    await wait(500);
    await win.webContents.executeJavaScript('window.massing.viewer.renderNow(), true');
    await win.webContents.capturePage();
  }
  await wait(500);
  await fs.writeFile(path.join(out, 'insolation.png'), (await win.webContents.capturePage()).toPNG());
  console.log('SHOT insolation');
  console.log('SHOTS готово');
}

/* Выгрузка модели в файл — чтобы проверить её сторонним разбором.
   Самопроверка говорит лишь, что экспортёр не упал; валиден ли
   получившийся glTF, видно только по самому файлу.
   Запуск: MASSING_GLB=/путь/model.glb npm start */
async function dumpGLB() {
  const dest = process.env.MASSING_GLB;
  const script = `(async () => {
    const $ = id => document.getElementById(id);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await wait(1200);
    if (!$('screen-pick').hidden) {
      document.querySelectorAll('.chip')[0].click();
      $('build').click();
      for (let i = 0; i < 200; i++) { await wait(400); if ($('loader').hidden) break; }
    }
    await wait(800);
    const v = window.massing.viewer;
    const buf = await v.exportGLB(window.massing.site || null);
    return Array.from(new Uint8Array(buf));
  })()`;
  try {
    const bytes = await win.webContents.executeJavaScript(script);
    require('node:fs').writeFileSync(dest, Buffer.from(bytes));
    console.log('GLBDUMP ' + JSON.stringify({ ok: true, path: dest, bytes: bytes.length }));
  } catch (e) {
    console.log('GLBDUMP ' + JSON.stringify({ ok: false, why: String(e.message || e) }));
  }
}

/* Прогон разметки: рисует линию и площадку, тащит вершину, отменяет,
   сохраняет участок и читает его обратно. Интерфейс разметки живёт на
   событиях указателя, и глазами по скриншоту его не проверить.
   Запуск: MASSING_DRAWTEST=1 npm start */
async function drawTest() {
  const out = await win.webContents.executeJavaScript(`(async () => {
    const $ = id => document.getElementById(id);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const errs = [];
    addEventListener('error', e => errs.push(String(e.message) + ' @ ' + String((e.error && e.error.stack) || '').slice(0, 180)));
    await wait(1200);
    if (!$('screen-pick').hidden) {
      document.querySelectorAll('.chip')[0].click();
      $('build').click();
      for (let i = 0; i < 200; i++) { await wait(400); if ($('loader').hidden) break; }
    }
    await wait(1500);

    const v = window.massing.viewer, cv = v.renderer.domElement;
    // Пока идёт подъём застройки, выбор намеренно отключён: вершины
    // двигает шейдер, а луч летит по исходным координатам. Прогон
    // обязан этого дождаться, иначе половина проверок ложно падает.
    for (let i = 0; i < 60 && v.growth; i++) await wait(100);
    const r = cv.getBoundingClientRect();
    const at = (fx, fy) => [r.left + r.width * fx, r.top + r.height * fy];
    const send = (type, x, y) => cv.dispatchEvent(new PointerEvent(type,
      { clientX: x, clientY: y, bubbles: true, pointerType: 'mouse' }));
    const click = (x, y) => { send('pointerdown', x, y); send('pointerup', x, y); };

    document.querySelector('#tabs .tab[data-tab="draw"]').click();

    // линия из трёх вершин с резиновой ниткой между кликами
    document.querySelector('#draw-tool button[data-tool="line"]').click();
    for (const f of [[0.40, 0.46], [0.48, 0.54], [0.56, 0.48]]) {
      const [x, y] = at(f[0], f[1]);
      send('pointermove', x, y); await wait(60);
      click(x, y); await wait(80);
    }
    const ghostOn = !!window.massing.draw.ghost;
    cv.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await wait(300);
    const afterLine = window.massing.draw.items.length;

    // выбор кликом и перетаскивание вершины
    document.querySelector('#draw-tool button[data-tool="none"]').click();
    const it = window.massing.draw.items[0];
    const before = it ? [...it.pts[0]] : null;
    const p0 = it ? v.groundPoint(...at(0.40, 0.46)) : null;
    const [sx, sy] = at(0.40, 0.46);
    click(sx, sy); await wait(200);
    const selected = window.massing.draw.selected;
    send('pointerdown', sx, sy); await wait(80);
    const dragging = !!window.massing.draw.dragging;
    const [dx, dy] = at(0.34, 0.40);
    send('pointermove', dx, dy); await wait(120);
    send('pointerup', dx, dy); await wait(200);
    const moved = it && before ? Math.hypot(it.pts[0][0] - before[0], it.pts[0][2] - before[2]) : 0;

    // отмена возвращает вершину
    $('draw-undo').click(); await wait(200);
    const back = window.massing.draw.items[0]
      ? Math.hypot(window.massing.draw.items[0].pts[0][0] - before[0],
                   window.massing.draw.items[0].pts[0][2] - before[2]) : -1;

    // Пометка домов. Точки ищем сканированием: в Замоскворечье
    // середина кадра приходится на канал и набережную, и заданные
    // наугад доли экрана в застройку не попадают.
    document.querySelector('#draw-tool button[data-tool="mark"]').click();
    const targets = [];
    for (let gy = 0.30; gy <= 0.80 && targets.length < 3; gy += 0.05) {
      for (let gx = 0.22; gx <= 0.68 && targets.length < 3; gx += 0.04) {
        const [x, y] = at(gx, gy);
        const b = v.pick(x, y);
        if (b && !targets.some(t2 => t2.id === b.id)) targets.push({ id: b.id, x, y });
      }
    }
    let marked = 0;
    for (const t2 of targets) { marked++; click(t2.x, t2.y); await wait(120); }

    // Инсоляция: считается в фоновом потоке, ответ приходит письмом.
    document.querySelector('#tabs .tab[data-tab="site"]').click();
    await wait(200);
    $('insol-run').click();
    for (let i = 0; i < 100 && !window.massing.insolation; i++) await wait(200);
    const ins = window.massing.insolation;
    const insol = ins
      ? { share2h: +(ins.share2h * 100).toFixed(0), max: ins.maxHours, min: ins.minHours,
          mean: ins.meanHours, ms: ins.ms, cells: ins.open, blockers: ins.blockers }
      : null;
    // Тот же участок в декабре: в июне под Москвой день семнадцать
    // часов, и почти всё открытое место набирает норматив. Проверка
    // имеет смысл только там, где солнца мало.
    window.massing.insolation = null;
    document.querySelector('#tabs .tab[data-tab="scene"]').click();
    $('date').value = '2026-12-21';
    $('date').dispatchEvent(new Event('input', { bubbles: true }));
    await wait(300);
    document.querySelector('#tabs .tab[data-tab="site"]').click();
    $('insol-run').click();
    for (let i = 0; i < 100 && !window.massing.insolation; i++) await wait(200);
    const w = window.massing.insolation;
    const insolWinter = w
      ? { share2h: +(w.share2h * 100).toFixed(0), max: w.maxHours, min: w.minHours, mean: w.meanHours, ms: w.ms }
      : null;

    document.querySelector('#tabs .tab[data-tab="draw"]').click();
    await wait(200);

    // Сохранение участка и чтение его обратно.
    $('save-site').click();
    await wait(300);
    $('ask-input').value = 'Прогон';
    $('ask-ok').click();
    await wait(300);
    const savedList = JSON.parse(localStorage.getItem('massing.projects') || '[]');
    const rec = savedList.find(x => x.name === 'Прогон');
    const savedItems = rec ? rec.draw.items.length : -1;
    const savedMarks = rec ? rec.draw.marks.length : -1;

    return JSON.stringify({
      ghostOn, afterLine, selected: !!selected, dragging,
      moved: +moved.toFixed(1), undoBack: +back.toFixed(2),
      marks: window.massing.draw.marks.size, markedHits: marked,
      savedItems, savedMarks, insol, insolWinter,
      growthStuck: !!v.growth, growValue: v.grow ? v.grow.value : null,
      hasMesh: !!v.buildingMesh, indexLen: window.massing.index.length,
      annotMeshes: v.groups.annot.children.length,
      markMeshes: v.groups.marks.children.length,
      errs
    });
  })()`).catch(e => JSON.stringify({ fatal: String(e) }));
  console.log('DRAWTEST ' + out);
}

app.whenReady().then(() => {
  serveFiles();
  relaxCors();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
