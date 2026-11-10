// Экран «Обзор» (v3): первый взгляд — решения и внимание; норма свёрнута.

import { h, sr } from './dom.js';
import { pageTitle, secTitle, empty, levelDot, legend, meter, fold, LEVEL_WORD } from './parts.js';
import { spark, dayStrip } from './charts.js';
import {
  overviewSummary, fmtSpan, fmtWhen, toMs, attentionHref, attentionLinkLabel, botNowInfo, botLabel, upcomingRows,
  projectLevel, subscriptionInfo, balanceInfo, fmtPct, gbNum, NBSP, count, buildHash, seriesOf,
} from './logic.js';

export function viewOverview(ctx) {
  const { s, now } = ctx;
  const sum = overviewSummary(s, now);
  const root = h('div', { class: 'overview' });
  root.append(pageTitle('Обзор', null), heroTiles(sum));

  const main = h('div', { class: 'col-main' }, asksSec(s, now), attentionSec(s), botsSec(ctx), upcomingSec(ctx));
  const side = h('div', { class: 'col-side' }, projectsSec(s), serverSec(ctx), subsSec(s, now));
  root.append(h('div', { class: 'cols' }, main, side));

  const notes = [];
  if (s.sourceErrors.length) notes.push(h('p', null, 'Не удалось прочитать: ', s.sourceErrors.map((e) => `${e.source} — ${e.message}`).join('; ')));
  if (ctx.resp.notify?.lastError) notes.push(h('p', null, `Уведомления: ${ctx.resp.notify.lastError}`));
  else if (ctx.resp.notify && !ctx.resp.notify.configured) notes.push(h('p', null, 'Уведомления в Telegram не настроены — сводки в 08:00 и тревог не будет.'));
  if (notes.length) {
    root.append(fold(
      [h('span', null, 'Служебные заметки · ', String(notes.length))],
      notes,
      { class: 'fold fold-notes', label: 'Служебные заметки' },
    ));
  }
  return root;
}

function heroTiles(sum) {
  const t1 = h('div', { class: 'tile' },
    h('span', { class: `v ${sum.asks ? 'red' : 'muted'}` }, String(sum.asks)),
    h('span', { class: 't' }, sum.asks ? `${sum.asks === 1 ? 'решение ждёт' : 'решения ждут'} тебя` : 'решений не ждёт',
      h('span', { class: 's' }, sum.asks ? `дольше всех — ${fmtSpan(sum.longestSec)}` : 'вопросов от ботов нет')));
  const t2 = h('div', { class: 'tile' },
    h('span', { class: `v ${sum.attention ? 'amber' : 'muted'}` }, String(sum.attention)),
    h('span', { class: 't' }, sum.attention ? (sum.attention === 1 ? 'требует внимания' : 'требуют внимания') : 'требуют внимания',
      h('span', { class: 's' }, sum.attention ? sum.attentionWhere : 'всё спокойно')));
  const ok = sum.failing.length === 0;
  const t3 = h('div', { class: 'tile' },
    h('span', { class: `v ${ok ? 'muted' : 'red'}`, 'aria-hidden': 'true' }, ok ? '✓' : '!'),
    h('span', { class: 't' }, ok ? (sum.asks || sum.attention ? 'остальное в норме' : 'всё в норме') : 'не всё работает',
      h('span', { class: 's' }, ok ? sum.totals : sum.failing.join(' · '))));
  return h('section', { class: 'hero', 'aria-label': 'Итог' }, t1, t2, t3);
}

function asksSec(s, now) {
  const sec = h('section', { class: 'sec sec-asks', 'aria-labelledby': 'ov-asks' }, secTitle('Нужно от тебя', 'ov-asks'));
  if (!s.asks.length) { sec.append(empty('Ничего не ждёт', 'Боты ни о чём не спрашивают.')); return sec; }
  // Компакт: одна строка + «ждёт N». Детали (проект · бот · блокирует) — в title и в раскрытии.
  const show = s.asks.slice(0, 5);
  const rest = s.asks.length - show.length;
  sec.append(h('ol', { class: 'list asks-compact' }, show.map((a, i) => {
    const sub = [];
    if (a.project) sub.push(`проект ${a.project}`);
    sub.push(`спросил ${botLabel(a.botName, a.bot)}`);
    if (a.blocks) sub.push(`без ответа стоит: ${a.blocks}`);
    const tip = sub.join(' · ');
    return h('li', { class: 'row3', title: tip },
      h('span', { class: 'n', 'aria-hidden': 'true' }, String(i + 1)),
      h('span', { class: 'main q-clamp' }, a.text, sr(` (${tip})`)),
      h('span', { class: 'go' }, `ждёт ${fmtSpan((now - toMs(a.since)) / 1000)}`));
  })));
  if (rest > 0) sec.append(h('p', { class: 'more' }, `ещё ${count(rest, 'решение', 'решения', 'решений')}`));
  return sec;
}

function attentionSec(s) {
  const sec = h('section', { class: 'sec sec-att', 'aria-labelledby': 'ov-att' }, secTitle('Требует внимания', 'ov-att'));
  if (!s.attention.length) { sec.append(empty('Всё спокойно', 'Правила сборщика ничего не нашли.')); return sec; }
  const order = { crit: 0, serious: 1, warn: 2 };
  const list = [...s.attention].sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));
  const show = list.slice(0, 5);
  const rest = list.length - show.length;
  sec.append(h('ul', { class: 'list' }, show.map((a) => h('li', null,
    h('a', { class: 'row3 rowlink', href: attentionHref(a.link), 'data-fkey': `att:${a.key}` },
      h('span', { class: 'n' }, levelDot(a.level)),
      h('span', { class: 'main q-clamp' },
        a.project ? h('span', { class: 'att-proj' }, a.project, ' · ') : null,
        a.text,
        sr(` (${LEVEL_WORD[a.level] ?? ''})`)),
      h('span', { class: 'go' }, `${attentionLinkLabel(a.link)} ›`))))));
  if (rest > 0) sec.append(h('p', { class: 'more' }, `ещё ${rest}`));
  return sec;
}

function botsSec(ctx) {
  const { s, now } = ctx;
  if (!s.bots.length) {
    const sec = h('section', { class: 'sec sec-bots', 'aria-labelledby': 'ov-bots' }, secTitle('Боты сейчас', 'ov-bots'));
    sec.append(empty('Ботов в снимке нет'));
    return sec;
  }
  const infos = s.bots.map((b) => ({ b, info: botNowInfo(b, s, now) }));
  const bad = infos.filter((x) => x.info.level === 'crit' || x.info.level === 'serious' || x.info.level === 'warn');
  const summary = bad.length
    ? h('span', null, h('strong', null, 'Боты'), ' · ', count(bad.length, 'с проблемой', 'с проблемами', 'с проблемами'))
    : h('span', null, h('strong', null, 'Боты'), ' · ', count(s.bots.length, 'в норме', 'в норме', 'в норме'));

  const body = [
    h('ul', { class: 'botrows' }, infos.map(({ b, info }) => h('li', { class: 'botrow' },
      h('span', { class: 'nm' }, levelDot(info.level), h('b', null, b.name)),
      h('span', { class: info.busy ? 'st' : info.level === 'good' ? 'st muted' : 'st red' }, info.status),
      h('span', { class: 'ab ink2' }, info.about || '—'),
      ctx.chart((w) => dayStrip(w, b, now), 'strip-host')))),
    legend([
      { sw: 'sw-chat', text: 'чат' }, { sw: 'sw-bg', text: 'фоновый ход' }, { sw: 'sw-live', text: 'идёт сейчас' },
      { sw: null, text: 'полоса — последние 24 часа' },
    ]),
  ];
  // Проблемы — открыто; норма — свёрнута.
  return fold(summary, body, { open: bad.length > 0, class: 'fold sec sec-bots', label: 'Боты сейчас' });
}

function upcomingSec(ctx) {
  const { s, now } = ctx;
  const rows = upcomingRows(s, ctx.resp.notify, now);
  if (!rows.length) {
    return fold(
      [h('span', null, h('strong', null, 'Ближайшие'), ' · ничего не запланировано')],
      [empty('Ничего не запланировано')],
      { class: 'fold sec sec-next', label: 'Дальше по расписанию' },
    );
  }
  const show = rows.slice(0, 3);
  const body = [
    h('ul', { class: 'kv2 left' }, show.map((r) => h('li', null,
      h('span', { class: 'k num' }, fmtWhen(r.at, now)),
      r.taskId && s.tasks.some((t) => t.id === r.taskId)
        ? h('a', { class: 'v ink2 plain', href: buildHash('tasks', r.taskId), 'data-fkey': `up:${r.taskId}:${r.at}` }, r.name)
        : h('span', { class: 'v ink2' }, r.name)))),
  ];
  if (rows.length > 3) body.push(h('p', { class: 'more' }, h('a', { class: 'plain', href: '#/tasks' }, `ещё ${rows.length - 3} на Задачах ›`)));
  return fold(
    [h('span', null, h('strong', null, 'Ближайшие'), ' · ', count(rows.length, 'по расписанию', 'по расписанию', 'по расписанию'))],
    body,
    { class: 'fold sec sec-next', label: 'Дальше по расписанию' },
  );
}

function projectsSec(s) {
  const sec = h('section', { class: 'sec sec-proj', 'aria-labelledby': 'ov-proj' }, secTitle('Проекты', 'ov-proj'));
  if (!s.projects.length) { sec.append(empty('Проектов нет', 'Боты ещё не завели карточки проектов.')); return sec; }
  // Скан: точка · имя · справа только красный счётчик asks.
  const sorted = [...s.projects].sort((a, b) => (b.asks.length - a.asks.length) || a.name.localeCompare(b.name, 'ru'));
  sec.append(h('ul', { class: 'kv2' }, sorted.map((p) => {
    const lvl = projectLevel(p);
    const right = p.asks.length
      ? h('span', { class: 'v red small num' }, String(p.asks.length))
      : h('span', { class: 'v' }, '');
    return h('li', { class: lvl === 'pause' ? 'paused' : null },
      h('a', { class: 'k rowlink-inline', href: '#/projects', 'data-fkey': `pj:${p.id}`, title: p.statusText },
        levelDot(lvl), h('span', { class: 'pname' }, p.name)),
      right);
  })));
  return sec;
}

function serverSec(ctx) {
  const { s } = ctx;
  const sv = s.server;
  const diskPct = sv.diskTotalGb ? (100 * sv.diskUsedGb) / sv.diskTotalGb : 0;
  const memPct = sv.memTotalMb ? (100 * sv.memUsedMb) / sv.memTotalMb : 0;
  const hot = diskPct >= 90 || memPct >= 90 || sv.cpuPct >= 90
    || s.attention.some((a) => a.link?.tab === 'server');

  const oneLine = h('p', { class: 'srvline' },
    h('a', { class: 'plain', href: '#/server', 'data-fkey': 'ov:srv' },
      hot ? 'Сервер · есть нагрузка' : 'Сервер в норме',
      ' · CPU ', h('b', null, fmtPct(sv.cpuPct)),
      ' · RAM ', h('b', null, `${gbNum(sv.memUsedMb)}`), ' из ', gbNum(sv.memTotalMb),
      ' · диск ', h('b', null, fmtPct(diskPct))));

  if (!hot) {
    return h('section', { class: 'sec sec-srv', 'aria-labelledby': 'ov-srv' },
      secTitle('Сервер', 'ov-srv'), oneLine);
  }

  const hist = ctx.history('24h');
  const cpu = seriesOf(hist.points, 'cpu'), mem = seriesOf(hist.points, 'mem');
  const from = ctx.now - 864e5, to = ctx.now;
  const sparkOrNote = (pts, title) => {
    if (hist.loading && !hist.points.length) return h('span', { class: 'spark-host muted small' }, 'загружаю…');
    if (hist.error && !hist.points.length) return h('span', { class: 'spark-host muted small' }, 'истории нет');
    return ctx.chart((w) => spark(w, { points: pts, from, to, title }), `spark-host${hist.dim ? ' dim' : ''}`);
  };
  const sec = h('section', { class: 'sec sec-srv', 'aria-labelledby': 'ov-srv' }, secTitle('Сервер', 'ov-srv'));
  sec.append(oneLine);
  sec.append(h('ul', { class: 'kv2' },
    h('li', null, h('a', { class: 'k plain', href: '#/server', 'data-fkey': 'ov:cpu' }, 'Процессор ', h('span', { class: 'muted' }, fmtPct(sv.cpuPct))), sparkOrNote(cpu, 'Процессор')),
    h('li', null, h('a', { class: 'k plain', href: '#/server', 'data-fkey': 'ov:mem' }, 'Память ', h('span', { class: 'muted' }, `${gbNum(sv.memUsedMb)} из ${gbNum(sv.memTotalMb)}${NBSP}ГБ`)), sparkOrNote(mem, 'Память')),
    h('li', null, h('a', { class: 'k plain', href: '#/server', 'data-fkey': 'ov:disk' }, 'Диск ', h('span', { class: 'muted' }, `${Math.round(sv.diskUsedGb)} из ${Math.round(sv.diskTotalGb)}${NBSP}ГБ`)),
      h('span', { class: 'spark-host meter-host' }, meter(diskPct, diskPct >= 90 ? 'm-warn' : '', `Диск занят на ${fmtPct(diskPct)}`)))));
  return sec;
}

function subsSec(s, now) {
  const rows = [];
  const problems = [];
  for (const quota of s.subscriptions ?? (s.subscription ? [s.subscription] : [])) {
    const sub = subscriptionInfo(quota, now);
    if (!sub) continue;
    const li = h('li', null, h('span', { class: 'k' }, quota.providerId === 'codex' ? 'Codex · подписка' : quota.providerId === 'claude' ? 'Claude · подписка' : 'Окно подписки'),
      h('span', { class: `v ${sub.stale ? 'muted' : sub.level === 'crit' ? 'red' : sub.level === 'warn' ? 'amber' : 'ink2'}` }, sub.text));
    rows.push(li);
    if (sub.stale || sub.level === 'crit' || sub.level === 'warn') problems.push(li);
  }
  for (const b of s.balances) {
    const bi = balanceInfo(b, now);
    const li = h('li', null, h('span', { class: 'k' }, b.name),
      h('span', { class: `v num ${bi.stale ? 'muted' : bi.level === 'warn' ? 'amber' : 'ink2'}`, title: bi.checked ? `проверено ${bi.checked}` : null }, bi.text));
    rows.push(li);
    if (bi.stale || bi.level === 'warn' || bi.level === 'crit') problems.push(li);
  }
  if (!rows.length) {
    return h('section', { class: 'sec sec-subs', 'aria-labelledby': 'ov-subs' },
      secTitle('Подписка и остатки', 'ov-subs'), empty('Нет данных', 'Сборщик не прислал ни подписку, ни остатки.'));
  }
  const ok = problems.length === 0;
  const summary = ok
    ? h('span', null, h('strong', null, 'Остатки'), ' · все в норме')
    : h('span', null, h('strong', null, 'Остатки'), ' · ', count(problems.length, 'проблема', 'проблемы', 'проблем'));
  return fold(summary, [h('ul', { class: 'kv2' }, rows)], {
    open: !ok,
    class: 'fold sec sec-subs',
    label: 'Подписка и остатки',
  });
}
