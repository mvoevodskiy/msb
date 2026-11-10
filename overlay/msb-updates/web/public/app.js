const errEl = document.getElementById('err');
const instructionEl = document.getElementById('instruction');
const formEl = document.getElementById('form');
const statusEl = document.getElementById('status');

let sessionToken = null;
let intentId = null;
let pollTimer = null;

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
    const info = await api('/v1/installer/info');
    instructionEl.textContent = info.instruction;
    instructionEl.classList.remove('hidden');
    formEl.classList.remove('hidden');
  } catch (e) {
    showErr(e.message || String(e));
  }
}

async function startInstall(type) {
  showErr('');
  const host = document.getElementById('host').value.trim();
  const port = Number(document.getElementById('port').value) || 22;
  if (!host) {
    showErr('Укажи хост');
    return;
  }
  try {
    const { intent } = await api('/v1/install/intents', {
      method: 'POST',
      body: JSON.stringify({ type, host, port }),
    });
    intentId = intent.id;
    statusEl.classList.remove('hidden');
    renderStatus(intent);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshStatus, 3000);
  } catch (e) {
    showErr(e.message || String(e));
  }
}

async function refreshStatus() {
  if (!intentId) return;
  try {
    const { intent } = await api(`/v1/install/intents/${intentId}`);
    renderStatus(intent);
    if (intent.status === 'done' || intent.status === 'failed') {
      clearInterval(pollTimer);
    }
  } catch (e) {
    showErr(e.message || String(e));
  }
}

function renderStatus(intent) {
  const lines = [
    `Задача: ${intent.id}`,
    `Тип: ${intent.type}`,
    `Статус: ${intent.status}`,
    intent.host ? `Хост: ${intent.host}:${intent.port}` : '',
    intent.error ? `Ошибка: ${intent.error}` : '',
    intent.ext_version ? `Обвязка: ${intent.ext_version}` : '',
    intent.core_version ? `Ядро: ${intent.core_version}` : '',
    '',
    'Лог:',
    ...(intent.log || []).slice(-12).map((l) => `• ${l.line}`),
  ].filter(Boolean);
  statusEl.textContent = lines.join('\n');
}

document.getElementById('btn-ext').onclick = () => startInstall('ext_overlay');
document.getElementById('btn-empty').onclick = () => startInstall('empty_bot');
boot();
