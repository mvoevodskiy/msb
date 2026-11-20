// Чистая логика интерфейса Пульта: время в МСК, числа по-русски, сводки, группы и «наблюдения».
// Без DOM — работает и в браузере, и в node (тесты: tests/ui/logic.test.ts). Типы — logic.d.ts.
// Все функции, которым нужно «сейчас», принимают now (мс) параметром: интерфейс считает его
// по часам веб-сервиса (receivedAt + ageSec), чтобы расхождение часов браузера не искажало «ждёт 13 ч».

export const TZ = 'Europe/Moscow';
export const NBSP = ' ';

const partsFmt = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** Число миллисекунд из ISO-строки или числа; NaN для мусора. */
export function toMs(t) {
  if (typeof t === 'number') return t;
  if (typeof t !== 'string') return NaN;
  return Date.parse(t);
}

/** Части даты в МСК. */
export function msk(t) {
  const p = {};
  for (const x of partsFmt.formatToParts(new Date(toMs(t)))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, hh: p.hour, mm: p.minute, ss: p.second };
}

/** Смещение МСК от UTC в мс для момента t (через Intl, без зашитых +3). */
export function mskOffsetMs(t) {
  const ms = Math.floor(toMs(t) / 1000) * 1000;
  const p = msk(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, +p.hh, +p.mm, +p.ss) - ms;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Разница в календарных днях МСК: от a до b (завтра = 1). */
export function dayDiff(a, b) {
  const pa = msk(a), pb = msk(b);
  return Math.round((Date.UTC(pb.y, pb.mo - 1, pb.d) - Date.UTC(pa.y, pa.mo - 1, pa.d)) / 864e5);
}

export const fmtTime = (t) => { const p = msk(t); return `${p.hh}:${p.mm}`; };
export const fmtDate = (t) => { const p = msk(t); return `${pad2(p.d)}.${pad2(p.mo)}`; };
export const fmtDateTime = (t) => `${fmtDate(t)} ${fmtTime(t)}`;

/** «13:45», «завтра 08:00», «вчера 23:10», «01.11 08:44» — относительно now. */
export function fmtWhen(t, now) {
  const dd = dayDiff(now, t);
  if (dd === 0) return fmtTime(t);
  if (dd === 1) return `завтра ${fmtTime(t)}`;
  if (dd === -1) return `вчера ${fmtTime(t)}`;
  return fmtDateTime(t);
}

/** Склонение: plural(3, 'бот', 'бота', 'ботов') → «бота». */
export function plural(n, one, few, many) {
  const a = Math.abs(Math.trunc(n)) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
/** «3 бота». */
export const count = (n, one, few, many) => `${fmtInt(n)} ${plural(n, one, few, many)}`;

const nfCache = new Map();
function nf(min, max) {
  const k = `${min}-${max}`;
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat('ru-RU', { minimumFractionDigits: min, maximumFractionDigits: max }));
  return nfCache.get(k);
}
/** Целое с пробелами-разделителями: «6 037». */
export const fmtInt = (n) => nf(0, 0).format(Math.round(n));
/** Число с ровно d знаками после запятой: «2,2». */
export const fmtFixed = (n, d) => nf(d, d).format(n);

/** «27 %» (неразрывный пробел). */
export const fmtPct = (v) => `${fmtInt(v)}${NBSP}%`;

/** Секунды → «меньше минуты», «45 мин», «1 ч 33 мин», «13 ч», «2 дня» — для «ждёт …», «работает …». */
export function fmtSpan(sec) {
  const s = Math.max(0, sec);
  if (s < 60) return 'меньше минуты';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${NBSP}мин`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 6) return mm ? `${h}${NBSP}ч ${mm}${NBSP}мин` : `${h}${NBSP}ч`;
  if (h < 48) return `${h}${NBSP}ч`;
  const d = Math.floor(h / 24);
  return `${d}${NBSP}${plural(d, 'день', 'дня', 'дней')}`;
}

/** Секунды → «20 с назад», «12 мин назад», «3 ч назад», «2 дня назад». */
export function fmtAgo(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}${NBSP}с назад`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${NBSP}мин назад`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}${NBSP}ч назад`;
  const d = Math.floor(h / 24);
  return `${d}${NBSP}${plural(d, 'день', 'дня', 'дней')} назад`;
}

/** Длительность хода точно: «37 с», «5 мин 08 с», «1 ч 29 мин». */
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}${NBSP}с`;
  if (s < 3600) return `${Math.floor(s / 60)}${NBSP}мин ${pad2(s % 60)}${NBSP}с`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}${NBSP}ч ${m % 60}${NBSP}мин`;
}

/** Длительность коротко: «37 с», «5 мин», «1 ч 29 мин». */
export function fmtDurShort(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}${NBSP}с`;
  return fmtMinutes(Math.floor(s / 60));
}

/** Минуты → «52 мин», «1 ч 33 мин», «2 ч». */
export function fmtMinutes(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}${NBSP}мин`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}${NBSP}ч ${r}${NBSP}мин` : `${h}${NBSP}ч`;
}

/** Токены: «850», «43 тыс.», «0,56 млн», «8,4 млн», «12 млн»; precise — всегда 2 знака в миллионах («1,52 млн»). */
export function fmtTokens(n, precise = false) {
  const v = Math.max(0, n || 0);
  if (precise && v >= 1e4) return `${fmtFixed(v / 1e6, 2)}${NBSP}млн`;
  if (v < 1000) return fmtInt(v);
  if (v < 1e5) return `${fmtInt(v / 1000)}${NBSP}тыс.`;
  if (v < 1e6) return `${fmtFixed(v / 1e6, 2)}${NBSP}млн`;
  if (v < 1e7) return `${fmtFixed(v / 1e6, 1)}${NBSP}млн`;
  return `${fmtInt(v / 1e6)}${NBSP}млн`;
}

/** Мегабайты (МиБ): «236 МБ», «1,0 ГБ», «9,7 ГБ». */
export function fmtMb(mb) {
  if (mb == null || !Number.isFinite(mb)) return '—';
  if (mb < 1024) return `${fmtInt(mb)}${NBSP}МБ`;
  return `${fmtFixed(mb / 1024, 1)}${NBSP}ГБ`;
}
/** Только число гигабайт для «3,1 из 9,7 ГБ». */
export const gbNum = (mb) => fmtFixed(mb / 1024, 1);

/** Гигабайты диска: «44 ГБ», «7,5 ГБ». */
export const fmtGb = (gb) => `${gb >= 10 ? fmtInt(gb) : fmtFixed(gb, 1)}${NBSP}ГБ`;

/** Ядра в среднем: «0,89», «меньше 0,01», «—». */
export function fmtCores(c) {
  if (c == null || !Number.isFinite(c)) return '—';
  if (c < 0.005) return 'меньше 0,01';
  return fmtFixed(c, 2);
}

/** Доллары: «$0,005», «$1,55», «$11,2». */
export function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.1) return `$${nf(1, 3).format(n)}`;
  if (n < 10) return `$${fmtFixed(n, 2)}`;
  return `$${fmtFixed(n, 1)}`;
}

/** Склеивает список: «a», «a и b», «a, b и c». */
export function joinAnd(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

// ---------- Маршруты ----------

const TABS = ['overview', 'bots', 'tasks', 'projects', 'server'];
export const RANGES = ['24h', '7d', '30d'];
export const RANGE_MS = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };
export const RANGE_LABEL = { '24h': '24 ч', '7d': '7 дней', '30d': '30 дней' };

/** '#/tasks/abc?range=7d' → { name: 'task', tab: 'tasks', id: 'abc', query: { range: '7d' } }. */
export function parseRoute(hash) {
  let raw = String(hash || '').replace(/^#/, '');
  // A Telegram launch hash is metadata, not an application route.
  if (/^tgWebApp(?:Data|Version|Platform|ThemeParams)=/.test(raw)) raw = '/';
  const [path, qs = ''] = raw.split('?');
  const query = {};
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    try { query[decodeURIComponent(k)] = decodeURIComponent(v); } catch { /* битый адрес — пропускаем */ }
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'overview', tab: 'overview', id: null, query };
  if (parts[0] === 'tasks' && parts.length >= 2) {
    let id = parts.slice(1).join('/');
    try { id = decodeURIComponent(id); } catch { /* оставляем как есть */ }
    return { name: 'task', tab: 'tasks', id, query };
  }
  if (parts.length === 1 && TABS.includes(parts[0]) && parts[0] !== 'overview') return { name: parts[0], tab: parts[0], id: null, query };
  return { name: 'notfound', tab: null, id: null, query };
}

/** Собирает адрес: buildHash('tasks', null, { bot: 'SMM' }) → '#/tasks?bot=SMM'. Пустые параметры опускаются. */
export function buildHash(tab, id, query) {
  let h = tab === 'overview' ? '#/' : `#/${tab}`;
  if (id != null) h += `/${encodeURIComponent(id)}`;
  const q = Object.entries(query || {}).filter(([, v]) => v != null && v !== '');
  if (q.length) h += '?' + q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return h;
}

export const validRange = (r, def = '24h') => (RANGES.includes(r) ? r : def);

/** Куда ведёт ссылка из «Требует внимания». */
export function attentionHref(link) {
  if (!link || !TABS.includes(link.tab)) return '#/';
  if (link.tab === 'tasks' && link.id) return buildHash('tasks', link.id);
  return buildHash(link.tab);
}
export function attentionLinkLabel(link) {
  if (!link) return 'Обзор';
  switch (link.tab) {
    case 'server': return 'Сервер';
    case 'tasks': return link.id ? 'Задача' : 'Задачи';
    case 'bots': return 'Боты';
    case 'projects': return 'Проекты';
    default: return 'Обзор';
  }
}

// ---------- Часы веб-сервиса ----------

/** «Сейчас» по часам веб-сервиса: receivedAt + ageSec на момент ответа + сколько прошло в браузере. */
export function serverNow(resp, fetchedAtClient, clientNow) {
  if (!resp || resp.receivedAt == null || resp.ageSec == null) return clientNow;
  const base = toMs(resp.receivedAt) + resp.ageSec * 1000;
  return Number.isFinite(base) ? base + (clientNow - fetchedAtClient) : clientNow;
}

/** Сколько секунд назад пришёл снимок — на текущий момент (тикает). */
export function currentAgeSec(resp, fetchedAtClient, clientNow) {
  if (!resp || resp.ageSec == null) return null;
  return resp.ageSec + Math.max(0, (clientNow - fetchedAtClient) / 1000);
}

// ---------- Состояния служб и ботов ----------

const STATE_WORD = {
  active: 'работает', failed: 'упала', inactive: 'остановлена',
  activating: 'запускается', deactivating: 'останавливается', unknown: 'неизвестно',
};
/** Слово для состояния службы. */
export const serviceStateWord = (state) => STATE_WORD[state] ?? String(state || 'неизвестно');
/** Уровень точки для состояния службы: good | warn | crit | off. */
export function serviceLevel(state, heavy = false) {
  if (state === 'failed') return 'crit';
  if (state === 'activating' || state === 'deactivating') return 'warn';
  if (state === 'active') return heavy ? 'serious' : 'good';
  return 'off';
}

/** «основной бот», «SMM-бот», «личный бот»; для таймеров сервера — «сервер». */
export function botLabel(name, id) {
  if (id === 'server') return 'сервер';
  const n = String(name || '').trim();
  if (!n) return 'бот';
  if (/^[A-Z0-9]+$/.test(n)) return `${n}-бот`;
  return `${n.charAt(0).toLowerCase()}${n.slice(1)} бот`;
}

/** Имя бота для фильтров и лент: из списка ботов, для таймеров — «Сервер». */
export function botShortName(botId, bots, fallback) {
  if (botId === 'server') return 'Сервер';
  return bots.find((b) => b.id === botId)?.name ?? fallback ?? botId;
}

// ---------- Обзор ----------

const TAB_WORD = { server: 'сервер', tasks: 'фоновые задачи', bots: 'боты', projects: 'проекты', overview: 'общее' };

/** Сводка для трёх плиток обзора. */
export function overviewSummary(s, now) {
  const longestSec = s.asks.length ? Math.max(...s.asks.map((a) => (now - toMs(a.since)) / 1000)) : 0;
  // Где проблемы: «сервер и фоновая задача «X»».
  const where = [];
  const taskIds = new Set();
  for (const a of s.attention) {
    if (a.link?.tab === 'tasks') { taskIds.add(a.link.id ?? '*'); continue; }
    const w = TAB_WORD[a.link?.tab] ?? 'общее';
    if (!where.includes(w)) where.push(w);
  }
  if (taskIds.size === 1 && !taskIds.has('*')) {
    const id = [...taskIds][0];
    const t = s.tasks.find((x) => x.id === id);
    where.push(t ? `фоновая задача «${t.name}»` : 'фоновая задача');
  } else if (taskIds.size > 0) where.push('фоновые задачи');

  const failing = [];
  for (const b of s.bots) if (b.service.state !== 'active') failing.push(`бот ${b.name} — ${serviceStateWord(b.service.state)}`);
  for (const sv of s.services) if (sv.state === 'failed') failing.push(`${sv.name} — упала`);
  if (s.platform.failed > 0) failing.push(`служебных процессов платформы — ${s.platform.failed}`);

  return {
    asks: s.asks.length,
    longestSec,
    attention: s.attention.length,
    attentionWhere: joinAnd(where),
    totals: `${count(s.bots.length, 'бот', 'бота', 'ботов')} · ${count(s.tasks.length, 'фоновая задача', 'фоновые задачи', 'фоновых задач')} · ${count(s.services.length, 'служба', 'службы', 'служб')}`,
    failing,
  };
}

/** Ближайший момент 08:00 МСК после now — время утренней сводки Пульта. */
export function nextDigestAt(now, hour = 8) {
  const off = mskOffsetMs(now);
  const local = now + off;
  const day = Math.floor(local / 864e5) * 864e5;
  let t = day + hour * 3600e3;
  if (t <= local) t += 864e5;
  return t - off;
}

/** «Дальше по расписанию»: upcoming + строка сводки Пульта (если уведомления настроены), по времени. */
export function upcomingRows(s, notify, now) {
  const rows = s.upcoming.map((u) => ({ at: toMs(u.at), name: u.name, taskId: u.taskId, digest: false }));
  if (notify?.configured) rows.push({ at: nextDigestAt(now), name: 'Сводка пульта → в Telegram', taskId: null, digest: true });
  rows.sort((a, b) => a.at - b.at);
  return rows;
}

/**
 * Состояние бота сейчас: слово, уровень точки, «о чём» (для обзора) и «дальше» (для таблицы ботов).
 * «Работает N мин» считается на момент снимка: при устаревших данных не растёт вместе с часами.
 */
export function botNowInfo(bot, s, now) {
  const at = Math.min(now, toMs(s.collectedAt) || now);
  const svcOk = bot.service.state === 'active';
  let status, busy = false;
  if (!svcOk) status = `служба ${serviceStateWord(bot.service.state)}`;
  else if (bot.now.busy) { busy = true; status = bot.now.since ? `работает ${fmtSpan((at - toMs(bot.now.since)) / 1000)}` : 'работает'; }
  else status = 'свободен';

  let about = '', sub = '';
  if (bot.now.busy) {
    const bits = [];
    if (bot.now.text) bits.push(bot.now.text);
    if (bot.now.kind === 'task' && !bot.now.text) bits.push('фоновый ход');
    if (bot.now.helpers > 0) bits.push(count(bot.now.helpers, 'помощник', 'помощника', 'помощников'));
    about = sub = bits.join(' · ');
  } else {
    const next = s.upcoming.find((u) => s.tasks.find((t) => t.id === u.taskId)?.bot === bot.id);
    if (next) {
      const when = `${dayDiff(now, next.at) === 0 ? 'в ' : ''}${fmtWhen(next.at, now)}`;
      about = `фон: ход «${next.name}» ${when}`;
      sub = `следующий фоновый ход ${when} — «${next.name}»`;
    } else if (bot.lastResult) about = `последний итог ${fmtWhen(bot.lastResult.at, now)}: ${bot.lastResult.text}`;
  }
  return { status, busy, level: serviceLevel(bot.service.state), about, sub };
}

/** «Все 3 работают с 28.10 23:25 · перезапусков не было». */
export function botsServiceLine(bots) {
  if (!bots.length) return '';
  const restarts = bots.reduce((n, b) => n + (b.service.restarts || 0), 0);
  const tail = restarts ? `перезапусков за время работы: ${restarts}` : 'перезапусков не было';
  const active = bots.filter((b) => b.service.state === 'active' && b.service.since);
  if (active.length === bots.length) {
    const sinces = active.map((b) => toMs(b.service.since));
    if (Math.max(...sinces) - Math.min(...sinces) <= 10 * 60e3) {
      const who = bots.length === 1 ? 'Работает' : bots.length === 2 ? 'Оба работают' : `Все ${bots.length === 3 ? 'три' : bots.length} работают`;
      return `${who} с ${fmtDateTime(Math.min(...sinces))} · ${tail}`;
    }
  }
  const per = bots.map((b) => (b.service.state === 'active' && b.service.since
    ? `${b.name} — с ${fmtDateTime(b.service.since)}`
    : `${b.name} — ${serviceStateWord(b.service.state)}`));
  return `${per.join(' · ')} · ${tail}`;
}

/** Подписка: текст и уровень. */
export function subscriptionInfo(sub, now) {
  if (!sub) return null;
  const st = String(sub.status || '');
  let text, level = null;
  if (st === 'allowed') text = 'в норме';
  else if (st === 'limited' || st === 'rejected' || st === 'blocked') { text = 'лимит исчерпан'; level = 'crit'; }
  else if (st.includes('warn')) { text = 'близко к лимиту'; level = 'warn'; }
  else { text = st || 'неизвестно'; }
  const bits = [text];
  if (sub.overage) { bits.push('расход сверх лимита'); level = level ?? 'warn'; }
  if (!sub.windows?.length && sub.resetsAt) bits.push(`сброс ${dayDiff(now, sub.resetsAt) === 0 ? 'в ' : ''}${fmtWhen(sub.resetsAt, now)}`);
  for (const w of sub.windows ?? []) {
    const duration = w.windowMinutes % 1440 === 0 ? `${w.windowMinutes / 1440} дн.` : w.windowMinutes % 60 === 0 ? `${w.windowMinutes / 60} ч` : `${w.windowMinutes} мин`;
    bits.push(`${duration}: осталось ${Math.round((100 - w.usedPercent) * 10) / 10}% · сброс ${fmtWhen(w.resetsAt, now)}`);
  }
  const stale = sub.stale === true || now - toMs(sub.updatedAt) > 6 * 3600e3 || (sub.windows ?? []).some(w => toMs(w.resetsAt) <= now);
  if (stale) bits.push(`на ${fmtWhen(sub.updatedAt, now)}, устарело`);
  return { text: bits.join(' · '), level, stale };
}

/** Остаток: строка и признаки. */
export function balanceInfo(b, now) {
  const bits = [b.value];
  if (b.stale && b.checkedAt) bits.push(`на ${fmtDate(b.checkedAt)}, устарело`);
  else if (b.stale) bits.push('устарело');
  if (b.ok === false) bits.push('ниже порога');
  if (b.note) bits.push(b.note);
  return { text: bits.join(' · '), level: b.ok === false ? 'warn' : null, stale: !!b.stale, checked: b.checkedAt ? fmtWhen(b.checkedAt, now) : null };
}

/** Уровень точки проекта и слово для неё. */
export function projectLevel(p) {
  if (p.status === 'ok') return 'good';
  if (p.status === 'warn') return 'warn';
  if (p.status === 'pause') return 'pause';
  return 'off';
}

/** Строка «Службы» проекта: «бот, почта — все в норме» или по каждой; тяжёлые помечаются. */
export function projectServicesParts(p, services) {
  if (!p.services.length) return [];
  const heavyNames = new Set(services.filter((s) => s.heavy).map((s) => s.name));
  const allOk = p.services.every((s) => s.state === 'active') && !p.services.some((s) => heavyNames.has(s.name));
  if (allOk) {
    const names = p.services.map((s) => s.name);
    return [{ text: `${names.join(', ')} — ${p.services.length > 1 ? 'все в норме' : 'в норме'}`, level: null }];
  }
  return p.services.map((s) => {
    if (s.state !== 'active') return { text: `${s.name} — ${serviceStateWord(s.state)}`, level: serviceLevel(s.state) };
    if (heavyNames.has(s.name)) return { text: `${s.name} — тяжёлая`, level: 'serious' };
    return { text: `${s.name} — в норме`, level: null };
  });
}

// ---------- Фоновые задачи ----------

export const RUN_WORD = { ok: 'итог', silent: 'молча', error: 'ошибка', missed: 'пропуск' };

/** Группы списка задач: требующие внимания и остальные (порядок внутри — как прислал сборщик). */
export function splitTasks(tasks) {
  return { attention: tasks.filter((t) => t.attention), ok: tasks.filter((t) => !t.attention) };
}

/** Фильтры по боту: «Все · 7», «Основной · 5», …, «Сервер · 1». Порядок — как боты в снимке, сервер в конце. */
export function botFilters(tasks, bots) {
  const counts = new Map();
  for (const t of tasks) counts.set(t.bot, (counts.get(t.bot) ?? 0) + 1);
  const keys = [...counts.keys()].sort((a, b) => rank(a) - rank(b));
  function rank(k) {
    if (k === 'server') return 1e6;
    const i = bots.findIndex((b) => b.id === k);
    return i < 0 ? 1e5 : i;
  }
  return [
    { key: 'all', label: 'Все', count: tasks.length },
    ...keys.map((k) => ({ key: k, label: botShortName(k, bots, tasks.find((t) => t.bot === k)?.botName), count: counts.get(k) })),
  ];
}
export const filterTasks = (tasks, key) => (!key || key === 'all' ? tasks : tasks.filter((t) => t.bot === key));

/** Подпись под именем задачи: «socpublisher · основной бот», «infosecurity · SMM-бот · таймер сервера». */
export function taskSubtitle(t) {
  const bits = [t.project ?? 'все проекты'];
  if (t.bot !== 'server') bits.push(botLabel(t.botName, t.bot));
  if (t.kind === 'timer' || t.bot === 'server') bits.push('таймер сервера');
  return bits.join(' · ');
}

/** «Последний ход»: «13:00 · молча · 5 мин», «13:20 · 29 постов · $0,005», «ещё не было». */
export function lastRunText(t, now) {
  const r = t.lastRun;
  if (!r) return 'ещё не было';
  const bits = [fmtWhen(r.at, now)];
  if (t.noAi && r.detail && r.status !== 'error') bits.push(r.detail);
  else {
    bits.push(RUN_WORD[r.status] ?? r.status);
    if (r.durationSec > 0) bits.push(fmtDurShort(r.durationSec));
  }
  return bits.join(' · ');
}

/** «Следующий»: время, «ждёт события», «—». */
export function nextRunText(t, now) {
  if (t.nextRunAt) return fmtWhen(t.nextRunAt, now);
  if (t.schedule.type === 'event') return 'ждёт события';
  return '—';
}

/** Сколько слотов пропуска попадает в [from, to]: слоты равномерно от gap.from до gap.to. */
export function gapSlotsIn(gap, from, to) {
  const a = toMs(gap.from), b = toMs(gap.to), n = Math.max(0, gap.missed | 0);
  if (n === 0 || b < from || a > to) return 0;
  if (n === 1) return a >= from && a <= to ? 1 : 0;
  const step = (b - a) / (n - 1);
  let k = 0;
  for (let i = 0; i < n; i++) { const t = a + i * step; if (t >= from && t <= to) k++; }
  return k;
}

const inGap = (t, gaps) => gaps.some((g) => t >= toMs(g.from) && t <= toMs(g.to));

/** Показатели задачи за период. Для 24 ч — из stats24h (их считает сборщик), для 7/30 дней — из runs и gaps. */
export function rangeStats(t, range, now) {
  const from = now - RANGE_MS[range];
  const runs = t.runs.filter((r) => { const x = toMs(r.at); return x >= from && x <= now; });
  const real = runs.filter((r) => r.status !== 'missed');
  const gaps = t.gaps.filter((g) => toMs(g.to) >= from && toMs(g.from) <= now);
  const commits = t.commits.filter((c) => { const x = toMs(c.at); return x >= from && x <= now; });
  const usdRuns = real.filter((r) => r.usd != null);
  const scheduled = t.schedule.type === 'cron' || t.schedule.type === 'interval';
  let st;
  if (range === '24h') {
    const s = t.stats24h;
    st = { runs: s.runs, ok: s.ok, silent: s.silent, error: s.error, missed: s.missed, tokens: s.tokens, minutes: s.minutes,
      usd: s.usd > 0 ? s.usd : null, expected: s.expected };
  } else {
    const missedLone = runs.filter((r) => r.status === 'missed' && !inGap(toMs(r.at), t.gaps)).length;
    const missed = missedLone + gaps.reduce((n, g) => n + gapSlotsIn(g, from, now), 0);
    st = {
      runs: real.length,
      ok: real.filter((r) => r.status === 'ok').length,
      silent: real.filter((r) => r.status === 'silent').length,
      error: real.filter((r) => r.status === 'error').length,
      missed,
      tokens: real.reduce((n, r) => n + (r.tokens || 0), 0),
      minutes: real.reduce((n, r) => n + (r.durationSec || 0), 0) / 60,
      usd: usdRuns.length ? usdRuns.reduce((n, r) => n + r.usd, 0) : null,
      expected: scheduled ? real.length + missed : null,
    };
  }
  return { ...st, from, to: now, runList: real, gaps, commits };
}

/** Даты пропусков в периоде: «28.10» или «28.10, 29.10». */
export function gapDates(gaps) {
  const out = [];
  for (const g of gaps) { const d = fmtDate(g.from); if (!out.includes(d)) out.push(d); }
  return out.join(', ');
}

/** Подпись под полоской ходов: «12 из 24 — пропуск 28.10», «событий не было», «3 хода». warn — показать жёлтым. */
export function stripSummary(t, range, now) {
  const st = rangeStats(t, range, now);
  if (st.runs === 0 && st.missed === 0) {
    if (t.schedule.type === 'event') return { text: 'событий не было', warn: false, empty: true };
    return { text: '—', warn: false, empty: true };
  }
  let text = st.expected != null ? `${st.runs} из ${st.expected}` : count(st.runs, 'ход', 'хода', 'ходов');
  if (st.missed > 0) text += ` — пропуск ${gapDates(st.gaps) || ''}`.trimEnd();
  if (st.error > 0) text += ` · ${count(st.error, 'ошибка', 'ошибки', 'ошибок')}`;
  return { text, warn: st.missed > 0 || st.error > 0, empty: false };
}

/** Ячейки полоски для 7/30 дней: по дню МСК — худший итог дня. Пустые дни — 'none'. */
export function dayCells(t, range, now) {
  const days = range === '7d' ? 7 : 30;
  const off = mskOffsetMs(now);
  const today = Math.floor((now + off) / 864e5);
  const cells = Array.from({ length: days }, () => ({ ok: 0, silent: 0, error: 0, missed: 0 }));
  const idx = (ms) => days - 1 - (today - Math.floor((ms + off) / 864e5));
  for (const r of t.runs) { const i = idx(toMs(r.at)); if (i >= 0 && i < days) cells[i][r.status] = (cells[i][r.status] ?? 0) + 1; }
  for (const g of t.gaps) {
    const a = toMs(g.from), b = toMs(g.to), n = Math.max(1, g.missed | 0);
    const step = n > 1 ? (b - a) / (n - 1) : 0;
    for (let k = 0; k < n; k++) { const i = idx(a + k * step); if (i >= 0 && i < days) cells[i].missed++; }
  }
  // Худший итог дня: ошибка > пропуск > итог > молча.
  return cells.map((c) => (c.error ? 'error' : c.missed ? 'missed' : c.ok ? 'ok' : c.silent ? 'silent' : 'none'));
}

/** Текстовый итог полоски для чтеца: «12 молча, 12 пропущено». */
export function slotsSummary(slots) {
  const c = { ok: 0, silent: 0, error: 0, missed: 0 };
  for (const x of slots) if (x in c) c[x]++;
  const bits = [];
  if (c.ok) bits.push(`${c.ok} с итогом`);
  if (c.silent) bits.push(`${c.silent} молча`);
  if (c.error) bits.push(`${c.error} с ошибкой`);
  if (c.missed) bits.push(`${c.missed} пропущено`);
  return bits.join(', ') || 'ходов не было';
}

/** Коммиты, которые вышли за время хода: от его начала до начала следующего (или до now). */
export function commitsForRun(t, runIndex, now) {
  const r = t.runs[runIndex];
  if (!r) return [];
  const a = toMs(r.at);
  const next = t.runs.slice(runIndex + 1).find((x) => x.status !== 'missed');
  const b = next ? toMs(next.at) : now;
  return t.commits.filter((c) => { const x = toMs(c.at); return x >= a && x < b; });
}

/** «Что вышло» для строки последних ходов. */
export function runOutcome(t, runIndex, now) {
  const r = t.runs[runIndex];
  const parts = [];
  if (r?.detail) parts.push(r.detail);
  for (const c of commitsForRun(t, runIndex, now)) parts.push(`коммит ${c.hash.slice(0, 7)} в ${fmtTime(c.at)}`);
  return parts.join(' · ');
}

/** Последние n ходов (новые сверху) с индексами в t.runs. */
export function lastRuns(t, n = 8) {
  const out = [];
  for (let i = t.runs.length - 1; i >= 0 && out.length < n; i--) if (t.runs[i].status !== 'missed') out.push({ run: t.runs[i], index: i });
  return out;
}

/**
 * Последние ходы со схлопыванием одинаковых «молча/итог» подряд (один status+detail, без коммитов).
 * Элемент: { run, index, count } — count > 1 значит группа. now нужен для границы коммитов.
 */
export function groupedLastRuns(t, n, now) {
  const recent = lastRuns(t, Math.max(n * 3, 24));
  const groups = [];
  for (const item of recent) {
    const key = `${item.run.status}\0${item.run.detail || ''}`;
    const hasCommit = commitsForRun(t, item.index, now).length > 0;
    const mergeable = (item.run.status === 'silent' || item.run.status === 'ok') && !hasCommit;
    const prev = groups[groups.length - 1];
    if (prev && mergeable && prev.mergeable && prev.key === key) { prev.count += 1; continue; }
    groups.push({ run: item.run, index: item.index, count: 1, key, mergeable });
    if (groups.length >= n) break;
  }
  return groups.map(({ run, index, count }) => ({ run, index, count }));
}

const RANGE_WORD = { '24h': 'сутки', '7d': '7 дней', '30d': '30 дней' };

/** Интервал пропуска по-человечески: «28.10 с 11:00 до 01:00» (если в пределах суток) или «с 26.10 11:00 до 28.10 01:00». */
export function gapWhen(g) {
  const a = toMs(g.from), b = toMs(g.to);
  if (b - a < 864e5) return `${fmtDate(a)} с ${fmtTime(a)} до ${fmtTime(b)}`;
  return `с ${fmtDateTime(a)} до ${fmtDateTime(b)}`;
}

/** Наблюдения по задаче — только факты, посчитанные из данных снимка. */
export function observations(t, range, now) {
  const st = rangeStats(t, range, now);
  const out = [];
  const period = RANGE_WORD[range];
  const runs = st.runList;

  if (st.runs === 0) {
    if (st.expected) out.push(`За ${period} ни одного хода из ${st.expected} по расписанию.`);
    else out.push(`За ${period} ходов не было.`);
  } else {
    // Молчание/итоги в KPI — сюда только отклонения и факты, которых там нет.
    if (st.commits.length) {
      const last = st.commits[st.commits.length - 1];
      out.push(`В проекте за ${period} ${count(st.commits.length, 'коммит', 'коммита', 'коммитов')}, последний — ${fmtWhen(last.at, now)}.`);
    }
    if (st.error > 0) {
      const lastErr = [...runs].reverse().find((r) => r.status === 'error');
      out.push(`${count(st.error, 'ход', 'хода', 'ходов')} с ошибкой${lastErr ? `, последний — ${fmtWhen(lastErr.at, now)}` : ''}.`);
    }
    // Помощники: доля токенов.
    const total = runs.reduce((n, r) => n + (r.tokens || 0), 0);
    const withH = runs.filter((r) => r.helpers > 0);
    if (withH.length && withH.length < runs.length && total > 0) {
      const share = (100 * withH.reduce((n, r) => n + (r.tokens || 0), 0)) / total;
      const rest = runs.filter((r) => !(r.helpers > 0));
      const avgSec = rest.reduce((n, r) => n + (r.durationSec || 0), 0) / rest.length;
      out.push(`${count(withH.length, 'ход', 'хода', 'ходов')} с помощниками — ${fmtPct(share)} токенов; остальные ${rest.length} — в среднем ${fmtDurShort(avgSec)} и ${fmtTokens(rest.reduce((n, r) => n + (r.tokens || 0), 0) / rest.length)} токенов на ход.`);
    } else if (withH.length && withH.length === runs.length) {
      out.push(`Во всех ${runs.length} ходах работали помощники.`);
    }
    // Самый затратный ход.
    if (runs.length >= 3 && total > 0) {
      const max = runs.reduce((m, r) => ((r.tokens || 0) > (m.tokens || 0) ? r : m), runs[0]);
      out.push(`Самый затратный ход — ${fmtWhen(max.at, now)}: ${fmtTokens(max.tokens, true)} токенов, ${fmtPct((100 * max.tokens) / total)} за ${period}.`);
    }
  }
  // Пропуски.
  for (const g of st.gaps) {
    out.push(`${gapWhen(g)} — ${count(g.missed, 'пропуск', 'пропуска', 'пропусков')} по расписанию${g.missed > 1 ? ' подряд' : ''}.`);
  }
  // Пульс.
  if (t.pulse) {
    const ageSec = (now - toMs(t.pulse.updatedAt)) / 1000;
    if (t.pulse.fresh) out.push(`Пульс обновлён в ${fmtWhen(t.pulse.updatedAt, now)} (${fmtAgo(ageSec)}) — свежий.`);
    else out.push(`Пульс несвежий: последнее обновление ${fmtWhen(t.pulse.updatedAt, now)} (${fmtAgo(ageSec)})${t.pulse.nextBy ? `, ждали к ${fmtWhen(t.pulse.nextBy, now)}` : ''}.`);
  }
  return out;
}

/** Пять показателей карточки задачи. level — цвет подписи (warn/crit/good) или null. */
export function taskKpis(t, range, now) {
  const st = rangeStats(t, range, now);
  const k = [];
  // 1. Ходы.
  k.push({
    label: 'Ходов', value: String(st.runs), extra: st.expected != null ? `из ${st.expected}` : null,
    sub: st.missed > 0 ? `${st.missed} ${plural(st.missed, 'пропущен', 'пропущено', 'пропущено')} ${gapDates(st.gaps)}`.trim() : st.expected != null ? 'без пропусков' : `за ${RANGE_WORD[range]}`,
    level: st.missed > 0 ? 'warn' : null,
  });
  // 2. Итог / молча / ошибки.
  k.push({
    label: 'Итог / молча / ошибки', value: `${st.ok} / ${st.silent} / ${st.error}`, extra: null,
    sub: st.runs ? `молча — ${fmtPct((100 * st.silent) / st.runs)} ходов` : 'ходов не было',
    level: st.error > 0 ? 'crit' : null,
  });
  // 3. Результат.
  if (st.commits.length) {
    const times = st.commits.slice(-4).map((c) => fmtWhen(c.at, now)).join(' · ');
    k.push({ label: 'Результат', value: count(st.commits.length, 'коммит', 'коммита', 'коммитов'), extra: null, sub: st.commits.length > 4 ? `… ${times}` : times, level: null });
  } else if (t.noAi && t.lastRun?.detail) {
    k.push({ label: 'Результат', value: t.lastRun.detail, extra: null, sub: `последний ход ${fmtWhen(t.lastRun.at, now)}`, level: null });
  } else {
    const lastOk = [...st.runList].reverse().find((r) => r.status === 'ok');
    k.push({ label: 'Результат', value: count(st.ok, 'итог', 'итога', 'итогов'), extra: null, sub: lastOk ? `последний — ${fmtWhen(lastOk.at, now)}` : 'итогов в чат не было', level: null });
  }
  // 4. Токены.
  k.push({
    label: 'Токены', value: t.noAi ? 'без ИИ' : fmtTokens(st.tokens), extra: null,
    sub: t.noAi ? 'таймер-скрипт, токенов не тратит' : st.usd != null && st.usd > 0 ? `≈ ${fmtUsd(st.usd)} по тарифу API` : `за ${RANGE_WORD[range]}`,
    level: null,
  });
  // 5. Пульс.
  if (t.pulse) {
    const sub = [t.pulse.phase, t.pulse.text].filter(Boolean).join(' · ') || (t.pulse.fresh ? 'свежий' : 'несвежий');
    k.push({ label: 'Пульс', value: fmtWhen(t.pulse.updatedAt, now), extra: null, dot: t.pulse.fresh ? 'good' : 'warn',
      dotWord: t.pulse.fresh ? 'свежий' : 'несвежий', sub: t.pulse.fresh ? sub : `несвежий · ${sub}`, level: t.pulse.fresh ? null : 'warn' });
  } else {
    k.push({ label: 'Пульс', value: '—', extra: null, sub: 'задача пульс не пишет', level: null });
  }
  return k;
}

/** Шапка карточки задачи: параметры через «·». Cron — во втором уровне (taskCron), не в шапке. */
export function taskParams(t, now) {
  const bits = [];
  bits.push(t.schedule.text);
  bits.push(t.bot === 'server' ? 'таймер сервера' : botLabel(t.botName, t.bot));
  if (t.project) bits.push(t.project);
  const KIND = { reminder: 'напоминание', prompt: 'задание ИИ', draft: 'черновик', digest: 'сводка', timer: 'таймер', other: 'другое' };
  bits.push(t.noAi ? 'без ИИ' : (KIND[t.kind] ?? t.kind));
  bits.push(t.nextRunAt ? `следующий ${fmtWhen(t.nextRunAt, now)}` : t.schedule.type === 'event' ? 'ждёт события' : 'следующего хода нет');
  return bits.join(' · ');
}

/** Cron для раскрытия «Параметры», если есть. */
export function taskCron(t) {
  return t.schedule.cron || null;
}

// ---------- Сервер ----------

/** Четыре показателя сервера. */
export function serverKpis(sv) {
  const memPct = sv.memTotalMb ? (100 * sv.memUsedMb) / sv.memTotalMb : 0;
  const diskPct = sv.diskTotalGb ? (100 * sv.diskUsedGb) / sv.diskTotalGb : 0;
  return [
    { label: `Процессор · ${count(sv.cores, 'ядро', 'ядра', 'ядер')}`, value: fmtPct(sv.cpuPct),
      sub: `нагрузка ${fmtFixed(sv.load1, 1)} · ожидание диска ${fmtPct(sv.iowaitPct)}` },
    { label: `Память · ${gbNum(sv.memTotalMb)}${NBSP}ГБ`, value: fmtMb(sv.memUsedMb),
      sub: `${fmtPct(memPct)} · ещё ${fmtMb(sv.memCacheMb)} кэш · свободно ${fmtMb(sv.memAvailMb)}` },
    { label: `Диск · ${fmtGb(sv.diskTotalGb)}`, value: fmtPct(diskPct), sub: `занято ${fmtGb(sv.diskUsedGb)} · свободно ${fmtGb(Math.max(0, sv.diskTotalGb - sv.diskUsedGb))}` },
    sv.swapTotalMb > 0
      ? { label: `Подкачка · ${fmtMb(sv.swapTotalMb)}`, value: fmtMb(sv.swapUsedMb), sub: `занято ${fmtPct((100 * sv.swapUsedMb) / sv.swapTotalMb)}` }
      : { label: 'Подкачка', value: '—', sub: 'не настроена' },
  ];
}

/** Строки таблицы служб: службы + службы ботов, по памяти (больше — выше). */
export function serviceRows(s) {
  const rows = s.services.map((x) => ({ id: x.id, name: x.name, project: x.project, state: x.state, since: x.since, restarts: x.restarts, memMb: x.memMb, cpuCores: x.cpuCores, heavy: x.heavy, bot: false }));
  for (const b of s.bots) {
    rows.push({ id: `bot:${b.id}`, name: `${b.name}${/^[A-Z0-9]+$/.test(b.name) ? '-бот' : ' бот'}`, project: null, state: b.service.state, since: b.service.since,
      restarts: b.service.restarts, memMb: b.service.memMb, cpuCores: b.service.cpuCores, heavy: false, bot: true });
  }
  rows.sort((a, b) => (b.heavy - a.heavy) || ((b.memMb ?? -1) - (a.memMb ?? -1)) || a.name.localeCompare(b.name, 'ru'));
  return rows;
}

/** Строка про служебные процессы платформы. */
export function platformLine(p) {
  if (!p || p.total === 0) return null;
  if (p.failed === 0) return { text: `Ещё ${count(p.total, 'служебный процесс', 'служебных процесса', 'служебных процессов')} платформы ботов — в норме`, level: null };
  return { text: `Служебные процессы платформы ботов: в норме ${p.ok} из ${p.total}, ${p.failed} — ${plural(p.failed, 'упал', 'упали', 'упали')}`, level: 'crit' };
}

// ---------- Графики: оси, ряды ----------

/** «Красивый» верх оси: 7,36 млн → 8 млн; 4,4 → 5. */
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Делит ряд точек на отрезки там, где между соседями дыра больше maxGapMs (нет данных — линия не рисуется). */
export function splitSegments(points, maxGapMs) {
  const segs = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    if (cur.length && points[i].t - points[i - 1].t > maxGapMs) { segs.push(cur); cur = []; }
    cur.push(points[i]);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/** Типичный шаг ряда (медиана разностей). */
export function medianStep(points) {
  if (points.length < 2) return 0;
  const d = [];
  for (let i = 1; i < points.length; i++) d.push(points[i].t - points[i - 1].t);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

const TICK_STEPS_H = [1, 2, 3, 6, 12, 24, 48, 72, 120, 168, 336];

/** Подписи оси времени по круглым часам МСК: не больше maxTicks. */
export function timeTicks(from, to, maxTicks) {
  const span = to - from;
  const stepH = TICK_STEPS_H.find((h) => span / (h * 3600e3) <= Math.max(1, maxTicks)) ?? 336;
  const off = mskOffsetMs(to);
  const step = stepH * 3600e3;
  // Для шагов от суток — от полуночи МСК; для дробных суток — от круглого часа.
  let t = Math.ceil((from + off) / step) * step - off;
  if (stepH >= 24) {
    const dayStep = stepH / 24;
    let d = Math.ceil((from + off) / 864e5);
    // Выравниваем дни на шаг, чтобы подписи не прыгали между обновлениями.
    d = Math.ceil(d / dayStep) * dayStep;
    t = d * 864e5 - off;
  }
  const out = [];
  for (; t <= to; t += step) {
    const p = msk(t);
    out.push({ t, label: stepH >= 24 ? `${pad2(p.d)}.${pad2(p.mo)}` : `${p.hh}:${p.mm}`, midnight: p.hh === '00' && p.mm === '00' });
  }
  return out;
}

/** Полночи МСК внутри [from, to] — для разделителей дней. */
export function midnights(from, to) {
  const off = mskOffsetMs(to);
  const out = [];
  for (let t = Math.ceil((from + off) / 864e5) * 864e5 - off; t <= to; t += 864e5) out.push(t);
  return out;
}

/** Ряды истории → точки {t (мс), v} для одного показателя, по времени. */
export function seriesOf(points, key) {
  return points
    .map((p) => ({ t: toMs(p.t), v: Number(p[key]) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
}

/** Текстовый итог ряда для подписи графика: «сейчас 27 %, за период от 2 до 96 %, в среднем 24 %». */
export function seriesSummary(pts, unit = '%') {
  if (!pts.length) return 'данных нет';
  let min = Infinity, max = -Infinity, sum = 0;
  for (const p of pts) { min = Math.min(min, p.v); max = Math.max(max, p.v); sum += p.v; }
  const u = unit === '%' ? `${NBSP}%` : unit;
  return `сейчас ${fmtInt(pts[pts.length - 1].v)}${u}, за период от ${fmtInt(min)} до ${fmtInt(max)}${u}, в среднем ${fmtInt(sum / pts.length)}${u}`;
}

/** Отрезки ленты «кто что делал» за 24 ч: строки по ботам (чат, фон) и «Сервер» (таймеры). */
export function laneRows(s, now) {
  const from = now - 864e5;
  const clip = (sp) => toMs(sp.end) >= from && toMs(sp.start) <= now;
  const rows = [];
  const timerTask = (t) => t.kind === 'timer' || t.bot === 'server';
  for (const b of s.bots) {
    const chat = b.timeline.filter((x) => x.kind === 'chat' && clip(x));
    const bg = b.timeline.filter((x) => x.kind === 'bg' && clip(x));
    const tasks = s.tasks.filter((t) => t.bot === b.id && !timerTask(t));
    rows.push({ key: `${b.id}:chat`, label: `${b.name} · чат`, kind: 'chat', spans: chat, gaps: [] });
    if (bg.length || tasks.length) {
      const gaps = [];
      for (const t of tasks) for (const g of t.gaps) if (toMs(g.to) >= from && toMs(g.from) <= now) gaps.push({ ...g, taskName: t.name });
      rows.push({ key: `${b.id}:bg`, label: `${b.name} · фон`, kind: 'bg', spans: bg, gaps });
    }
  }
  const timers = s.tasks.filter(timerTask);
  if (timers.length) {
    const spans = [];
    const gaps = [];
    for (const t of timers) {
      for (const r of t.runs) {
        const a = toMs(r.at);
        if (r.status === 'missed' || a < from || a > now) continue;
        spans.push({ start: r.at, end: new Date(a + (r.durationSec || 0) * 1000).toISOString(), kind: 'bg', status: r.status,
          label: [t.name, r.detail].filter(Boolean).join(' · ') });
      }
      for (const g of t.gaps) if (toMs(g.to) >= from && toMs(g.from) <= now) gaps.push({ ...g, taskName: t.name });
    }
    rows.push({ key: 'server', label: 'Сервер', kind: 'bg', spans, gaps });
  }
  return { from, to: now, rows };
}

/** Подсказка к отрезку ленты. */
export function spanTooltip(sp, now) {
  const a = toMs(sp.start), b = sp.live ? now : toMs(sp.end);
  const what = sp.live ? 'идёт сейчас' : sp.kind === 'chat' ? 'чат' : RUN_WORD[sp.status] ? `фоновый ход · ${RUN_WORD[sp.status]}` : 'фоновый ход';
  return {
    title: sp.label || (sp.kind === 'chat' ? 'запрос в чате' : 'фоновый ход'),
    sub: `${fmtTime(a)}–${sp.live ? 'сейчас' : fmtTime(b)} · ${fmtDurShort((b - a) / 1000)} · ${what}`,
  };
}

// ---------- Свежесть и плашки ----------

/** Что показать в шапке справа. */
export function headerStatus({ resp, error, loading, ageSec }) {
  if (!resp) {
    if (error) return { level: 'crit', text: 'нет связи с сервером Пульта' };
    return { level: 'off', text: loading ? 'загружаю…' : 'нет данных' };
  }
  if (!resp.snapshot) return { level: error ? 'crit' : 'off', text: error ? 'нет связи · данных ещё нет' : 'сборщик ещё не прислал данные' };
  const at = `${fmtDate(resp.snapshot.collectedAt)}, ${fmtTime(resp.snapshot.collectedAt)}`;
  if (error) return { level: 'crit', text: `${at} · нет связи`, short: 'нет связи' };
  if (resp.stale) return { level: 'warn', text: `${at} · устарело`, short: 'устарело' };
  return { level: 'good', text: `${at} · обновлено ${ageSec == null ? '' : fmtAgo(ageSec)}`.trim(), short: fmtTime(resp.snapshot.collectedAt) };
}

/** Плашка «данные устарели». */
export function staleBanner(resp, ageSec, now) {
  if (!resp?.snapshot || !resp.stale) return null;
  const silent = ageSec != null ? fmtSpan(ageSec) : null;
  return `Данные от ${fmtWhen(resp.snapshot.collectedAt, now)} — сборщик молчит${silent ? ` ${silent}` : ''}`;
}
