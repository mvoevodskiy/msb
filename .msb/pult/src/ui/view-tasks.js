// Экраны «Фоновые задачи» и «Карточка задачи» (v3: норма свёрнута, без expect в таблице).

import { h, dot } from './dom.js';
import { pageTitle, secTitle, empty, levelDot, legend, seg, runStrip, fold } from './parts.js';
import { runBars } from './charts.js';
import {
  splitTasks, botFilters, filterTasks, taskSubtitle, lastRunText, nextRunText, stripSummary, dayCells, slotsSummary,
  rangeStats, RANGE_LABEL, RANGE_MS, RANGES, validRange, buildHash, fmtTokens, fmtWhen, fmtDur, fmtDateTime, RUN_WORD,
  taskKpis, taskParams, taskCron, observations, groupedLastRuns, runOutcome, count, toMs, plural, medianStep,
} from './logic.js';

const STRIP_LEGEND = [
  { sw: 'sw-ok', text: 'итог в чат' }, { sw: 'sw-silent', text: 'молча' },
  { sw: 'sw-missed', text: 'должен был быть, но не случился' }, { sw: 'sw-err', text: 'ошибка' },
];

function stripFor(t, range, now) {
  if (range === '24h') {
    if (!t.slots24h.length) return null;
    return runStrip(t.slots24h, `Ходы за 24 часа: ${slotsSummary(t.slots24h)}`);
  }
  const cells = dayCells(t, range, now);
  if (cells.every((c) => c === 'none')) return null;
  return runStrip(cells, `Ходы за ${RANGE_LABEL[range]} по дням: ${slotsSummary(cells)}`);
}

function tokensFor(t, range, now) {
  if (t.noAi) return { text: 'без ИИ', muted: true };
  const tok = range === '24h' ? t.stats24h.tokens : rangeStats(t, range, now).tokens;
  return tok > 0 ? { text: fmtTokens(tok), muted: false } : { text: '', muted: true };
}

function taskRow(t, range, now, cols) {
  const sum = stripSummary(t, range, now);
  const strip = stripFor(t, range, now);
  const tok = tokensFor(t, range, now);
  const href = buildHash('tasks', t.id, range === '24h' ? null : { range });
  return h('tr', { class: 'clickable', 'data-href': href },
    h('td', { class: 'c-dot' }, levelDot(t.attention ?? 'good')),
    h('th', { scope: 'row', class: 'c-name' },
      h('a', { class: 'tn plain', href, 'data-fkey': `task:${t.id}` }, t.name),
      h('div', { class: 'muted small' }, taskSubtitle(t)),
      t.attentionText ? h('div', { class: `small ${t.attention === 'crit' ? 'red' : t.attention === 'serious' ? 'orange' : 'amber'}` }, t.attentionText) : null),
    h('td', null, t.schedule.text),
    h('td', { class: t.lastRun ? 'nowrap-md' : 'muted' }, lastRunText(t, now)),
    h('td', { class: 'c-strip' }, strip, sum.warn || !strip ? h('div', { class: `small ${sum.warn ? 'amber' : 'muted'}` }, sum.text) : null),
    h('td', { class: tok.muted ? 'r muted' : 'r' }, tok.text),
    h('td', { class: t.nextRunAt ? 'nowrap' : 'muted nowrap' }, nextRunText(t, now)));
}

function taskCard(t, range, now) {
  const sum = stripSummary(t, range, now);
  const tok = tokensFor(t, range, now);
  const href = buildHash('tasks', t.id, range === '24h' ? null : { range });
  const next = t.nextRunAt ? `дальше ${nextRunText(t, now)}` : null;
  return h('li', null, h('a', { class: 'card card-link', href, 'data-fkey': `taskc:${t.id}` },
    h('span', { class: 'card-head' }, h('b', null, t.name), t.attention ? levelDot(t.attention) : null),
    h('span', { class: 'muted small block' }, [t.schedule.text, next].filter(Boolean).join(' · ')),
    t.attentionText ? h('span', { class: 'amber small block' }, t.attentionText) : null,
    stripFor(t, range, now),
    h('span', { class: 'ink2 small block' }, [
      sum.warn ? sum.text : null,
      `последний: ${lastRunText(t, now)}`,
      tok.text ? `${tok.text} токенов` : null,
    ].filter(Boolean).join(' · '))));
}

export function viewTasks(ctx) {
  const { s, now, route } = ctx;
  const range = validRange(route.query.range);
  const filters = botFilters(s.tasks, s.bots);
  const botKey = filters.some((f) => f.key === route.query.bot) ? route.query.bot : 'all';
  const q = (over) => ({ bot: botKey === 'all' ? null : botKey, range: range === '24h' ? null : range, ...over });

  const root = h('div', { class: 'tasks' });
  const hiddenLink = s.tasksHidden > 0
    ? h('span', { class: 'ghost-link', title: 'В снимок не входят' }, `Выключенные · ${s.tasksHidden}`)
    : null;
  root.append(h('div', { class: 'pagehead' },
    h('div', { class: 'ph-left' }, pageTitle('Фоновые задачи и таймеры'),
      s.tasks.length ? seg('Фильтр по боту', filters.map((f) => ({ key: f.key, label: `${f.label} · ${f.count}`, href: buildHash('tasks', null, q({ bot: f.key === 'all' ? null : f.key })) })), botKey, 'tf') : null),
    h('div', { class: 'ph-right' }, hiddenLink,
      seg('Период', RANGES.map((r) => ({ key: r, label: RANGE_LABEL[r], href: buildHash('tasks', null, q({ range: r === '24h' ? null : r })) })), range, 'tr'))));

  if (!s.tasks.length) {
    root.append(empty('Фоновых задач нет', s.tasksHidden ? `Активных нет; выключенных и отработавших — ${s.tasksHidden}.` : 'Ни у ботов, ни у сервера нет активных фоновых задач.'));
    return root;
  }
  const list = filterTasks(s.tasks, botKey);
  const groups = splitTasks(list);
  const colRuns = `Ходы за ${RANGE_LABEL[range]}`;
  const cols = 7;

  // Внимание — всегда открыто.
  if (groups.attention.length) {
    const tbody = h('tbody');
    tbody.append(h('tr', { class: 'grp' }, h('th', { scope: 'colgroup', colspan: String(cols) }, `Требует внимания · ${groups.attention.length}`)));
    for (const t of groups.attention) tbody.append(taskRow(t, range, now, cols));
    const table = h('table', { class: 'tbl tasks-tbl wide-only' },
      h('caption', { class: 'sr-only' }, `Фоновые задачи, период — ${RANGE_LABEL[range]}.`),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', class: 'c-dot' }, h('span', { class: 'sr-only' }, 'Состояние')),
        h('th', { scope: 'col' }, 'Задача'), h('th', { scope: 'col' }, 'Как часто'), h('th', { scope: 'col' }, 'Последний ход'),
        h('th', { scope: 'col' }, colRuns), h('th', { scope: 'col', class: 'r' }, 'Токены'), h('th', { scope: 'col' }, 'Следующий'))),
      tbody);
    wireRowClicks(tbody);
    root.append(table);

    root.append(h('div', { class: 'narrow-only' },
      h('h2', { class: 'lbl grp-lbl' }, `Требует внимания · ${groups.attention.length}`),
      h('ul', { class: 'cards' }, groups.attention.map((t) => taskCard(t, range, now)))));
  }

  // В норме — свёрнута по умолчанию.
  if (groups.ok.length) {
    const tbody = h('tbody');
    for (const t of groups.ok) tbody.append(taskRow(t, range, now, cols));
    const table = h('table', { class: 'tbl tasks-tbl wide-only' },
      h('thead', { class: 'sr-only' }, h('tr', null,
        h('th', { scope: 'col' }, 'Состояние'), h('th', { scope: 'col' }, 'Задача'), h('th', { scope: 'col' }, 'Как часто'),
        h('th', { scope: 'col' }, 'Последний ход'), h('th', { scope: 'col' }, colRuns), h('th', { scope: 'col' }, 'Токены'),
        h('th', { scope: 'col' }, 'Следующий'))),
      tbody);
    wireRowClicks(tbody);
    const cards = h('ul', { class: 'cards narrow-only' }, groups.ok.map((t) => taskCard(t, range, now)));
    root.append(fold(
      [h('span', null, h('strong', null, 'В норме'), ` · ${groups.ok.length}`)],
      [table, cards],
      { class: 'fold fold-tasks-ok', label: `В норме, ${groups.ok.length}` },
    ));
  }

  if (!list.length) root.append(empty('У этого бота фоновых задач нет'));

  root.append(fold(
    [h('span', { class: 'muted' }, 'Обозначения полоски ходов')],
    [legend([{ sw: null, text: 'Ходы:' }, ...STRIP_LEGEND,
      { sw: null, text: range === '24h' ? '· клетка — ход по расписанию' : '· клетка — день, цвет — худший итог дня' },
      { sw: null, text: '· строка открывает карточку задачи' }], 'Обозначения полоски ходов')],
    { class: 'fold fold-legend', label: 'Обозначения' },
  ));
  return root;
}

function wireRowClicks(tbody) {
  tbody.addEventListener('click', (ev) => {
    if (ev.target.closest('a')) return;
    const tr = ev.target.closest('tr[data-href]');
    if (tr) location.hash = tr.dataset.href;
  });
}

// ---------- Карточка задачи ----------

export function viewTask(ctx) {
  const { s, now, route } = ctx;
  const t = s.tasks.find((x) => x.id === route.id);
  const crumb = h('nav', { class: 'crumb', 'aria-label': 'Где я' }, h('a', { href: '#/tasks', 'data-fkey': 'crumb' }, 'Задачи'), ' ›');
  if (!t) {
    return h('div', { class: 'task' }, crumb, pageTitle('Задача больше не активна'),
      h('p', { class: 'ink2' }, `Задачи «${route.id}» нет среди активных: её выключили, она отработала (разовая) или её переименовали. В снимок попадают только активные задачи${s.tasksHidden ? ` (выключенных и отработавших сейчас ${s.tasksHidden})` : ''}.`),
      h('p', null, h('a', { href: '#/tasks', class: 'btn' }, '← К списку задач')));
  }
  const range = validRange(route.query.range);
  const root = h('div', { class: 'task' }, crumb);
  const cron = taskCron(t);
  root.append(h('div', { class: 'pagehead top' },
    h('div', { class: 'ph-left col' },
      pageTitle(t.name),
      h('p', { class: 'ink2 params' }, taskParams(t, now)),
      cron ? fold([h('span', { class: 'muted' }, 'О задаче · cron')], [h('code', { class: 'cron-code' }, cron)], { class: 'fold fold-about' }) : null),
    h('div', { class: 'ph-right' }, seg('Период', RANGES.map((r) => ({ key: r, label: RANGE_LABEL[r], href: buildHash('tasks', t.id, r === '24h' ? null : { range: r }) })), range, 'kr'))));

  const about = [];
  if (t.expect) about.push(h('p', { class: 'expect ink2' }, h('span', { class: 'muted' }, 'Чего ждать: '), t.expect));
  if (t.attentionText) about.push(h('p', { class: 'expect' }, levelDot(t.attention ?? 'warn'), ' ', h('span', { class: t.attention === 'crit' ? 'red' : 'amber' }, t.attentionText)));
  if (about.length) root.append(h('div', { class: 'about' }, about));

  // KPI: первые три акцентные, пульс/нулевой результат — приглушены через класс.
  const kpis = taskKpis(t, range, now);
  root.append(h('dl', { class: 'kpis k5' }, kpis.map((k, i) => {
    const secondary = i >= 3 && !k.level && (k.value === '—' || k.value.startsWith('0 ') || k.value === '0 итогов' || /^0\b/.test(k.value));
    return h('div', { class: `kpi${secondary ? ' kpi-sec' : ''}` },
      h('dt', { class: 'l' }, k.label),
      h('dd', { class: 'v' }, k.dot ? dot(k.dot, k.dotWord) : null, k.value, k.extra ? h('span', { class: 'x' }, ` ${k.extra}`) : null),
      h('dd', { class: `d ${k.level === 'warn' ? 'amber' : k.level === 'crit' ? 'red' : ''}` }, k.sub));
  })));

  // График ходов.
  let from = now - RANGE_MS[range];
  const starts = [...t.runs.map((r) => toMs(r.at)), ...t.gaps.map((g) => toMs(g.from))];
  let title = `Ходы за ${RANGE_LABEL[range]}`;
  if (starts.length) {
    const first = Math.min(...starts);
    if (first > from) {
      const step = medianStep(t.runs.map((r) => ({ t: toMs(r.at) }))) || 3600e3;
      from = Math.max(from, first - step);
      const days = Math.max(1, Math.ceil((now - from) / 864e5));
      if (range !== '24h') title = `Ходы за ${days} ${plural(days, 'день', 'дня', 'дней')} (первый ход — ${fmtDateTime(first).slice(0, 5)})`;
    }
  }
  const tokens = !t.noAi && t.runs.some((r) => r.tokens > 0);
  root.append(h('section', { class: 'sec', 'aria-labelledby': 'tk-chart' },
    secTitle(`${title} · ${tokens ? 'высота — токены за ход' : 'высота одинаковая: без ИИ'}`, 'tk-chart'),
    t.runs.length || t.gaps.length
      ? ctx.chart((w) => runBars(w, { task: t, from, to: now, now, height: w < 560 ? 180 : 220 }), 'bars-host')
      : empty('Ходов ещё не было', t.nextRunAt ? `Первый ход — ${fmtWhen(t.nextRunAt, now)}.` : null),
    fold(
      [h('span', { class: 'muted' }, 'Обозначения')],
      [legend([
        { sw: 'sw-ok', text: 'итог в чат' }, { sw: 'sw-silent', text: 'молча' }, { sw: 'sw-err', text: 'ошибка' },
        { sw: 'sw-gaparea', text: 'пропуск' }, { sw: 'sw-commit', text: 'под осью — коммит в проекте' },
      ])],
      { class: 'fold fold-legend' },
    )));

  // Последние ходы (схлоп одинаковых) и наблюдения (только если есть что сказать сверх KPI).
  const recent = groupedLastRuns(t, 8, now);
  const runsSec = h('section', { class: 'sec', 'aria-labelledby': 'tk-runs' }, secTitle('Последние ходы', 'tk-runs'));
  if (!recent.length) runsSec.append(empty('Ходов ещё не было'));
  else {
    runsSec.append(h('table', { class: 'tbl wide-only runs-tbl' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Начало'), h('th', { scope: 'col' }, 'Итог'), h('th', { scope: 'col', class: 'r' }, 'Длительность'),
        h('th', { scope: 'col', class: 'r' }, 'Токены'), h('th', { scope: 'col', class: 'r' }, 'Помощники'), h('th', { scope: 'col' }, 'Что вышло'))),
      h('tbody', null, recent.map(({ run, index, count: n }) => {
        const out = runOutcome(t, index, now);
        const outcomeCell = n > 1
          ? h('td', { class: 'muted' }, `${out || RUN_WORD[run.status] || run.status} · ×${n}`)
          : h('td', { class: out ? null : 'muted' }, out || '—');
        return h('tr', null,
          h('td', { class: 'num nowrap' }, fmtWhen(run.at, now)),
          h('td', { class: run.status === 'error' ? 'red' : 'ink2' }, RUN_WORD[run.status] ?? run.status),
          h('td', { class: 'r' }, n > 1 ? '—' : fmtDur(run.durationSec)),
          h('td', { class: t.noAi ? 'r muted' : 'r' }, n > 1 ? '—' : (t.noAi ? '—' : fmtTokens(run.tokens, true))),
          h('td', { class: run.helpers ? 'r' : 'r muted' }, n > 1 ? '—' : (run.helpers ? String(run.helpers) : '—')),
          outcomeCell);
      }))));
    runsSec.append(h('ul', { class: 'runlist narrow-only' }, recent.map(({ run, index, count: n }) => {
      const out = runOutcome(t, index, now);
      if (n > 1) {
        return h('li', null,
          h('span', { class: 'num' }, fmtDateTime(run.at)), ' · ',
          h('span', { class: 'ink2' }, RUN_WORD[run.status] ?? run.status),
          h('span', { class: 'muted small block' }, `×${n} одинаковых подряд`));
      }
      const bits = [fmtDur(run.durationSec)];
      if (!t.noAi) bits.push(`${fmtTokens(run.tokens, true)} токенов`);
      if (run.helpers) bits.push(count(run.helpers, 'помощник', 'помощника', 'помощников'));
      return h('li', null,
        h('span', { class: 'num' }, fmtDateTime(run.at)), ' · ', h('span', { class: run.status === 'error' ? 'red' : 'ink2' }, RUN_WORD[run.status] ?? run.status),
        h('span', { class: 'muted small block' }, bits.join(' · ')),
        out ? h('span', { class: 'small block' }, out) : null);
    })));
  }
  const obs = observations(t, range, now);
  const obsSec = h('section', { class: 'sec', 'aria-labelledby': 'tk-obs' }, secTitle('Наблюдения', 'tk-obs'));
  if (!obs.length) {
    obsSec.append(h('p', { class: 'muted small' }, 'Ничего сверх показателей выше.'));
  } else {
    obsSec.append(
      h('p', { class: 'muted small obs-note' }, `посчитано по данным снимка за ${RANGE_LABEL[range]}, без ИИ и без догадок`),
      h('ul', { class: 'list obs' }, obs.map((o) => h('li', { class: 'ink2' }, o))));
  }
  root.append(h('div', { class: 'split' }, runsSec, obsSec));
  return root;
}
