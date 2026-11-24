const errEl = document.getElementById('err');
const instructionEl = document.getElementById('instruction');

let sessionToken = null;

function showErr(msg) {
  errEl.textContent = msg || '';
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function boot() {
  const t = new URLSearchParams(location.search).get('t');
  if (!t) {
    showErr('Открой страницу по одноразовой ссылке из Telegram-бота.');
    return;
  }
  try {
    const redeemed = await api('/v1/auth/web-redeem', {
      method: 'POST',
      body: JSON.stringify({ token: t }),
    });
    sessionToken = redeemed.token;
    history.replaceState({}, '', '/');
    instructionEl.textContent = 'Новая установка MSB — в боте: «Создать сервер» или «Настроить систему».';
    instructionEl.classList.remove('hidden');
  } catch (e) {
    showErr(e.message || String(e));
  }
}

boot();
