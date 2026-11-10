// Мост Telegram Mini App (CSP script-src 'self').
// Вход без пароля: читаем initData и POST /api/tg-auth.
// Hash разбираем как в SDK Telegram: значение tgWebAppData — до следующего &tgWebApp…=,
// а не через URLSearchParams (он обрезает value на первом «&» внутри initData).

function postEvent(eventType, eventData) {
  try {
    const proxy = globalThis.TelegramWebviewProxy;
    if (proxy?.postEvent) {
      proxy.postEvent(eventType, eventData == null ? '' : JSON.stringify(eventData));
    }
  } catch { /* старый клиент */ }
}

function expandWebApp() {
  const tg = globalThis.Telegram?.WebApp;
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      if (typeof tg.setHeaderColor === 'function') tg.setHeaderColor('#121212');
      if (typeof tg.setBackgroundColor === 'function') tg.setBackgroundColor('#121212');
      document.documentElement.dataset.tg = '1';
      return;
    } catch { /* ignore */ }
  }
  if (globalThis.TelegramWebviewProxy) {
    postEvent('web_app_ready');
    postEvent('web_app_expand');
    postEvent('web_app_set_header_color', { color: '#121212' });
    postEvent('web_app_set_background_color', { color: '#121212' });
    document.documentElement.dataset.tg = '1';
  }
}

function urlSafeDecode(urlencoded) {
  try {
    return decodeURIComponent(String(urlencoded || '').replace(/\+/g, '%20'));
  } catch {
    return String(urlencoded || '');
  }
}

/** Достать сырой initData из hash WebView. */
function initDataFromHash() {
  let hash = '';
  try {
    hash = String(location.hash || '').replace(/^#/, '');
  } catch {
    return '';
  }
  if (!hash) return '';
  const q = hash.indexOf('?');
  if (q >= 0) hash = hash.slice(q + 1);
  const key = 'tgWebAppData=';
  const start = hash.indexOf(key);
  if (start < 0) return '';
  let value = hash.slice(start + key.length);
  // Следующий параметр платформы Telegram (не поле внутри initData).
  const stop = value.search(/&tgWebApp(?:Version|Platform|ThemeParams|DataSend|DefaultAppButtonColor|DefaultHeaderColor|BotInline|Debug)=/);
  if (stop >= 0) value = value.slice(0, stop);
  return urlSafeDecode(value);
}

function readInitData() {
  // Hash — источник правды при открытии Mini App (sessionStorage мог сохранить битый разбор).
  const fromHash = initDataFromHash();
  if (fromHash && fromHash.includes('hash=')) {
    try {
      sessionStorage.setItem('__pult_tg_init', JSON.stringify({ initData: fromHash }));
    } catch { /* private mode */ }
    return fromHash;
  }

  const fromSdk = globalThis.Telegram?.WebApp?.initData;
  if (typeof fromSdk === 'string' && fromSdk.length > 10 && fromSdk.includes('hash=')) return fromSdk;

  try {
    const stored = JSON.parse(sessionStorage.getItem('__pult_tg_init') || 'null');
    if (stored && typeof stored.initData === 'string' && stored.initData.includes('hash=')) return stored.initData;
  } catch { /* ignore */ }
  return '';
}

function setStatus(text) {
  const el = document.getElementById('tg-auth-status');
  if (el) el.textContent = text;
}

async function tryMiniAppLogin() {
  if (!document.body.classList.contains('auth-page')) {
    // Telegram adds its launch parameters even when the session already exists.
    // They are not an app route: drop them before the hash router sees them.
    if (/^#tgWebApp(?:Data|Version|Platform|ThemeParams)=/.test(location.hash)) {
      try { sessionStorage.removeItem('__pult_tg_init'); } catch { /* private mode */ }
      try { history.replaceState(history.state, '', `${location.pathname}${location.search}#/`); }
      catch { /* the router still treats the launch hash as overview */ }
    }
    return;
  }
  const initData = readInitData();
  if (!initData) return;
  setStatus('Вход через Telegram…');
  try {
    const r = await fetch('/api/tg-auth', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData }),
    });
    if (r.ok) {
      try { sessionStorage.removeItem('__pult_tg_init'); } catch { /* ignore */ }
      // Убрать hash, чтобы после входа не гонять auth снова.
      location.replace('/');
      return;
    }
    try { sessionStorage.removeItem('__pult_tg_init'); } catch { /* ignore */ }
    const body = await r.json().catch(() => ({}));
    setStatus(typeof body.error === 'string' ? body.error : 'Не удалось войти через Telegram');
  } catch {
    setStatus('Нет связи с Пультом');
  }
}

expandWebApp();
void tryMiniAppLogin();
