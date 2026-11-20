// Пульт — интерфейс. Опрос /api/snapshot каждые 30 с (и при возвращении на вкладку), история для графиков —
// /api/history по требованию экрана. Маршруты — hash: #/ #/bots #/tasks #/tasks/<id> #/projects #/server.
// Весь вывод — через dom.js (только текстовые узлы), обработчики — addEventListener: CSP script-src 'self'.

import { h, clearActive } from './dom.js';
import { viewOverview } from './view-overview.js';
import { viewBots } from './view-bots.js';
import { viewTasks, viewTask } from './view-tasks.js';
import { viewProjects } from './view-projects.js';
import { viewServer } from './view-server.js';
import { pageTitle, empty } from './parts.js';
import { parseRoute, serverNow, currentAgeSec, headerStatus, staleBanner, fmtWhen, validRange } from './logic.js';

const POLL_MS = 30_000;
const HISTORY_TTL_MS = 5 * 60_000;
const HISTORY_RETRY_MS = 30_000;
const SCHEMA = 1;
const TITLES = { overview: 'Обзор', bots: 'Боты', tasks: 'Задачи', task: 'Задача', projects: 'Проекты', server: 'Сервер', notfound: 'Нет такого экрана' };

const st = {
  resp: null,          // последний ответ /api/snapshot
  fetchedAt: 0,        // когда он пришёл (часы браузера)
  loading: true,
  error: null,         // { text } — последняя попытка не удалась
  nextPollAt: 0,
  timer: 0,
  inflight: false,
  history: {},         // range → { points, loading, error, expires }
  route: parseRoute(location.hash),
  lastKey: '',
};

const $ = (id) => document.getElementById(id);
const $main = $('main');
const $banner = $('banner');
const $status = $('status');

// ---------- Графики: перерисовка по фактической ширине ----------

let charts = [];
function chart(draw, cls) {
  const host = h('div', { class: `chart ${cls || ''}` });
  charts.push({ host, draw, w: -1 });
  return host;
}
function drawCharts() {
  for (const c of charts) {
    if (!c.host.isConnected) continue;
    const w = Math.floor(c.host.clientWidth);
    if (w <= 0 || w === c.w) continue;
    c.w = w;
    try { c.host.replaceChildren(c.draw(w)); } catch (e) {
      console.error(e);
      c.host.replaceChildren(h('p', { class: 'chart-msg' }, `График не построился: ${e.message}`));
    }
  }
}
let resizeT = 0;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { clearActive(); drawCharts(); }, 120); });

// ---------- Данные ----------

function nowMs() { return serverNow(st.resp, st.fetchedAt, Date.now()); }
function ageSec() { return currentAgeSec(st.resp, st.fetchedAt, Date.now()); }

function errText(e, what) {
  if (e && e.status) return `Сервер Пульта ответил ошибкой ${e.status} на запрос ${what}`;
  if (e && e.parse) return `Сервер Пульта прислал непонятный ответ на запрос ${what}`;
  return 'Нет связи с сервером Пульта';
}

async function getJson(url) {
  let res;
  try { res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } }); }
  catch { throw { network: true }; }
  if (res.status === 401) { location.assign('/login'); throw { auth: true }; }
  if (!res.ok) { res.body?.cancel().catch(() => {}); throw { status: res.status }; }
  try { return await res.json(); } catch { throw { parse: true }; }
}

async function poll() {
  clearTimeout(st.timer);
  if (st.inflight) return;
  st.inflight = true;
  try {
    const data = await getJson('/api/snapshot');
    if (!data || typeof data !== 'object' || !('snapshot' in data)) throw { parse: true };
    const key = `${data.receivedAt}|${data.stale}|${data.snapshot?.collectedAt}|${data.notify?.lastError}`;
    const changed = key !== st.lastKey || st.error != null || st.loading;
    st.resp = data;
    st.fetchedAt = Date.now();
    st.error = null;
    st.loading = false;
    st.lastKey = key;
    if (changed) render('data'); else updateChrome();
  } catch (e) {
    if (e && e.auth) return;
    st.error = { text: errText(e, 'снимка') };
    st.loading = false;
    render('data');
  } finally {
    st.inflight = false;
    st.nextPollAt = Date.now() + POLL_MS;
    st.timer = setTimeout(poll, POLL_MS);
  }
}

/** История для графиков: из памяти, если свежая; иначе запрос в фоне (экран перерисуется по приходу). */
function history(range) {
  const e = st.history[range];
  if (!e || (!e.loading && Date.now() > e.expires)) loadHistory(range);
  const cur = st.history[range];
  return { points: cur?.points ?? [], loading: !!cur?.loading, error: cur?.error ?? null, dim: !!cur?.loading && !!cur?.points?.length };
}

async function loadHistory(range) {
  const prev = st.history[range];
  st.history[range] = { points: prev?.points ?? null, loading: true, error: null, expires: 0 };
  try {
    const data = await getJson(`/api/history?range=${encodeURIComponent(range)}`);
    if (!data || !Array.isArray(data.points)) throw { parse: true };
    st.history[range] = { points: data.points, loading: false, error: null, expires: Date.now() + HISTORY_TTL_MS };
  } catch (e) {
    if (e && e.auth) return;
    st.history[range] = { points: prev?.points ?? null, loading: false, error: errText(e, 'истории').replace(/^Нет связи с сервером Пульта$/, 'нет связи'), expires: Date.now() + HISTORY_RETRY_MS };
  }
  const r = st.route;
  if (r.name === 'overview' || r.name === 'server') render('data');
}

// ---------- Отрисовка ----------

function updateNav() {
  const tab = st.route.tab;
  const asks = st.resp?.snapshot?.asks?.length ?? 0;
  for (const a of document.querySelectorAll('a[data-tab]')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  for (const b of document.querySelectorAll('[data-badge]')) {
    b.hidden = asks === 0;
    b.replaceChildren(h('span', { 'aria-hidden': 'true' }, b.dataset.badge === 'dot' ? '' : ' · '), String(asks), h('span', { class: 'sr-only' }, ` ${asks === 1 ? 'решение ждёт' : 'решения ждут'} тебя`));
  }
}

function updateChrome() {
  const age = ageSec();
  const hs = headerStatus({ resp: st.resp, error: st.error, loading: st.loading, ageSec: age });
  $status.replaceChildren(h('span', { class: `dot d-${hs.level}`, 'aria-hidden': 'true' }),
    h('span', { class: 'st-long' }, hs.text), h('span', { class: 'st-short', 'aria-hidden': 'true' }, hs.short ?? hs.text));
  const cd = $banner.querySelector('[data-countdown]');
  if (cd) cd.textContent = String(Math.max(0, Math.ceil((st.nextPollAt - Date.now()) / 1000)));
  const sb = $banner.querySelector('[data-stale]');
  if (sb) sb.textContent = staleBanner(st.resp, age, nowMs()) ?? '';
}

function renderBanners() {
  const out = [];
  if (st.error) {
    const snap = st.resp?.snapshot;
    out.push(h('div', { class: 'banner b-crit', role: 'status' },
      h('span', null, `${st.error.text} — повторю через `, h('span', { 'data-countdown': '' }, '30'), ' с.',
        snap ? ` Показываю последний известный снимок от ${fmtWhen(snap.collectedAt, nowMs())}.` : ''),
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => poll() }, 'Повторить сейчас')));
  }
  const stale = staleBanner(st.resp, ageSec(), nowMs());
  if (stale && !st.error) out.push(h('div', { class: 'banner b-warn', role: 'status' }, h('span', { 'data-stale': '' }, stale)));
  const schema = st.resp?.snapshot?.schema;
  if (schema != null && schema !== SCHEMA) out.push(h('div', { class: 'banner b-warn' }, `Снимок в формате версии ${schema}, интерфейс знает версию ${SCHEMA} — часть данных может отображаться неверно. Обнови страницу.`));
  $banner.replaceChildren(...out);
  $banner.hidden = out.length === 0;
}

function buildView() {
  const r = st.route;
  if (!st.resp) {
    if (st.loading) return h('div', { class: 'loading', 'aria-busy': 'true' }, pageTitle('Загружаю…'), h('div', { class: 'skel' }, h('i'), h('i'), h('i')));
    return h('div', null, pageTitle('Нет связи'), empty('Нет связи с сервером Пульта', 'Данных пока нет ни одного снимка. Повторю через 30 с.'));
  }
  if (!st.resp.snapshot) return h('div', null, pageTitle('Данных ещё нет'), empty('Сборщик ещё не прислал данные', 'Как только придёт первый снимок, панель заполнится. Проверяю каждые 30 с.'));
  if (r.name === 'notfound') return h('div', null, pageTitle('Нет такого экрана'), h('p', null, h('a', { href: '#/', class: 'btn' }, '← На обзор')));
  const ctx = { s: st.resp.snapshot, resp: st.resp, now: nowMs(), route: r, chart, history };
  switch (r.name) {
    case 'bots': return viewBots(ctx);
    case 'tasks': return viewTasks(ctx);
    case 'task': return viewTask(ctx);
    case 'projects': return viewProjects(ctx);
    case 'server': return viewServer(ctx);
    default: return viewOverview(ctx);
  }
}

function render(reason) {
  const active = document.activeElement;
  const fkey = active && active !== document.body ? active.getAttribute('data-fkey') : null;
  clearActive();
  updateNav();
  renderBanners();
  updateChrome();
  charts = [];
  let view;
  try { view = buildView(); } catch (e) {
    console.error(e);
    view = h('div', null, pageTitle('Не удалось показать экран'), h('p', { class: 'ink2' }, `Ошибка интерфейса: ${e.message}. Данные в снимке, вероятно, другой формы — сообщи разработчику.`));
  }
  $main.replaceChildren(view);
  drawCharts();
  const title = st.route.name === 'task' ? (st.resp?.snapshot?.tasks.find((t) => t.id === st.route.id)?.name ?? TITLES.task) : TITLES[st.route.name];
  const asks = st.resp?.snapshot?.asks?.length ?? 0;
  document.title = `${asks ? `(${asks}) ` : ''}${title} — Пульт`;
  if (reason === 'route') {
    window.scrollTo(0, 0);
    $main.querySelector('[data-focus="title"]')?.focus({ preventScroll: true });
  } else if (fkey) {
    const el = $main.querySelector(`[data-fkey="${CSS.escape(fkey)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
}

// ---------- События ----------

window.addEventListener('hashchange', () => {
  const prev = st.route;
  st.route = parseRoute(location.hash);
  const same = prev.name === st.route.name && prev.id === st.route.id;
  // Открытие «Сервера» — свежая история (старые точки видны, пока идёт запрос).
  if (!same && st.route.name === 'server') {
    const e = st.history[validRange(st.route.query.range)];
    if (e && !e.loading) e.expires = 0;
  }
  render(same ? 'query' : 'route');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - st.fetchedAt > 5000) poll();
});

$('skip')?.addEventListener('click', (ev) => {
  ev.preventDefault();
  ($main.querySelector('[data-focus="title"]') ?? $main).focus();
});

setInterval(updateChrome, 1000);

// Первый экран — «Загружаю…», затем снимок; история подтянется при отрисовке обзора или сервера.
// Фокус при первой загрузке не трогаем (браузер начинает с начала страницы), переводим только при смене экрана.
render('init');
poll();
