/* ============================================================
   Живая перезагрузка при правках исходников.

   Сервер следит за app/* и index.html и присылает событие через
   SSE. Правка стилей подменяется на лету — модель остаётся в сцене.
   Правка кода перезагружает страницу, но участок, ракурс и настройки
   солнца восстанавливаются: собирать заново квартал ради одной
   изменённой строки бессмысленно, тем более что данные лежат в кэше.

   Модуль включается только на localhost.
   ============================================================ */

const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

export function initLiveReload(getSnapshot) {
  if (!isLocal) return;

  const badge = document.createElement('div');
  badge.className = 'live-badge';
  document.body.appendChild(badge);

  const flash = (text, ms = 1400) => {
    badge.textContent = text;
    badge.classList.add('on');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => badge.classList.remove('on'), ms);
  };

  let src = null;
  const connect = () => {
    src = new EventSource('/__events');
    src.onmessage = (e) => {
      if (e.data === 'hello') return;
      if (e.data === 'css') return swapStyles(flash);
      reload(getSnapshot, flash);
    };
    src.onerror = () => {
      src.close();
      // Сервер перезапускают руками — тихо ждём и пробуем снова.
      setTimeout(connect, 1200);
    };
  };
  connect();
}

// Стили меняем без перезагрузки: подставляем новый адрес и снимаем
// старый только после загрузки, иначе страница моргает белым.
function swapStyles(flash) {
  document.querySelectorAll('link[rel=stylesheet]').forEach(link => {
    const base = link.href.split('?')[0];
    if (!base.includes('/app/')) return;
    const next = link.cloneNode();
    next.href = `${base}?v=${Date.now()}`;
    next.addEventListener('load', () => link.remove(), { once: true });
    link.after(next);
  });
  flash('стили обновлены');
}

const SNAP_KEY = 'massing.snapshot';

function reload(getSnapshot, flash) {
  let snap = null;
  try { snap = getSnapshot?.(); } catch { /* состояние необязательно */ }

  // Пока идёт запрос к модели, перезагрузка обрубила бы ответ.
  if (snap?.busy) {
    flash('правка принята — перезагружу после ответа модели', 4000);
    setTimeout(() => reload(getSnapshot, flash), 1500);
    return;
  }
  if (snap) sessionStorage.setItem(SNAP_KEY, JSON.stringify(snap));
  flash('перезагрузка…', 4000);
  setTimeout(() => location.reload(), 90);
}

export function takeSnapshot() {
  try {
    const raw = sessionStorage.getItem(SNAP_KEY);
    sessionStorage.removeItem(SNAP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
