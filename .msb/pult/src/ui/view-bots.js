// Экран «Боты»: таблица (на телефоне — карточки) и лента «Кто что делал · 24 часа».

import { h } from './dom.js';
import { pageTitle, secTitle, empty, levelDot, legend, fold } from './parts.js';
import { lanes } from './charts.js';
import { botNowInfo, fmtWhen, fmtMinutes, fmtTokens, fmtMb, count, botsServiceLine, laneRows } from './logic.js';

function cells(b, ctx) {
  const { s, now } = ctx;
  const info = botNowInfo(b, s, now);
  const nowSub = info.sub;
  const last = b.lastResult
    ? [`${fmtWhen(b.lastResult.at, now)} · ${b.lastResult.text}`,
      [fmtMinutes(b.lastResult.durationMin), b.lastResult.actions != null ? count(b.lastResult.actions, 'действие', 'действия', 'действий') : null].filter(Boolean).join(', ')]
    : ['итогов ещё не было', ''];
  const chat = b.chat24h.requests ? `${count(b.chat24h.requests, 'запрос', 'запроса', 'запросов')} · ${fmtMinutes(b.chat24h.minutes)}` : null;
  const bg = b.bg24h.runs || b.bg24h.tasks ? `${count(b.bg24h.runs, 'ход', 'хода', 'ходов')} · ${fmtTokens(b.bg24h.tokens)}` : null;
  return { info, nowSub, last, chat, bg, mem: fmtMb(b.service.memMb) };
}

export function viewBots(ctx) {
  const { s, now } = ctx;
  const root = h('div', { class: 'bots' }, pageTitle('Боты'));
  if (!s.bots.length) { root.append(empty('Ботов в снимке нет', 'Проверь список ботов в настройках сборщика.')); return root; }

  const rows = s.bots.map((b) => ({ b, c: cells(b, ctx) }));
  root.append(h('table', { class: 'tbl wide-only' },
    h('caption', { class: 'sr-only' }, 'Боты: состояние, последний итог, работа за сутки'),
    h('thead', null, h('tr', null,
      h('th', { scope: 'col', class: 'c-dot' }, h('span', { class: 'sr-only' }, 'Состояние')),
      h('th', { scope: 'col' }, 'Бот'), h('th', { scope: 'col' }, 'Сейчас'), h('th', { scope: 'col' }, 'Последний итог'),
      h('th', { scope: 'col', class: 'r' }, 'Чат за 24 ч'), h('th', { scope: 'col', class: 'r' }, 'Фон за 24 ч'),
      h('th', { scope: 'col', class: 'r' }, 'Память'), h('th', { scope: 'col' }, 'Проекты'))),
    h('tbody', null, rows.map(({ b, c }) => h('tr', null,
      h('td', { class: 'c-dot' }, levelDot(c.info.level)),
      h('th', { scope: 'row', class: 'tn' }, b.name),
      h('td', null, h('span', { class: c.info.level === 'good' ? null : 'red' }, c.info.status), c.nowSub ? h('div', { class: 'muted small' }, c.nowSub) : null),
      h('td', null, c.last[0], c.last[1] ? h('div', { class: 'muted small' }, c.last[1]) : null),
      h('td', { class: c.chat ? 'r' : 'r muted' }, c.chat ?? 'запросов не было'),
      h('td', { class: c.bg ? 'r' : 'r muted' }, c.bg ?? 'задач нет'),
      h('td', { class: 'r' }, c.mem),
      h('td', { class: 'ink2' }, b.projects.join(', ') || '—'))))));

  root.append(h('ul', { class: 'cards narrow-only' }, rows.map(({ b, c }) => h('li', { class: 'card' },
    h('div', { class: 'card-head' }, h('span', null, levelDot(c.info.level), ' ', h('b', null, b.name)), h('span', { class: c.info.level === 'good' ? 'muted' : 'red' }, c.info.status)),
    c.nowSub ? h('p', { class: 'ink2' }, c.nowSub) : null,
    h('dl', { class: 'pk' },
      h('div', null, h('dt', null, 'Итог'), h('dd', null, c.last[0], c.last[1] ? h('span', { class: 'muted small block' }, c.last[1]) : null)),
      h('div', null, h('dt', null, 'Чат, 24 ч'), h('dd', { class: c.chat ? null : 'muted' }, c.chat ?? 'запросов не было')),
      h('div', null, h('dt', null, 'Фон, 24 ч'), h('dd', { class: c.bg ? null : 'muted' }, c.bg ?? 'задач нет')),
      h('div', null, h('dt', null, 'Память'), h('dd', null, c.mem)),
      h('div', null, h('dt', null, 'Проекты'), h('dd', { class: 'ink2' }, b.projects.join(', ') || '—')))))));

  root.append(h('p', { class: 'note' }, botsServiceLine(s.bots)));

  root.append(h('section', { class: 'sec sec-lanes', 'aria-labelledby': 'bt-lanes' },
    secTitle('Кто что делал · 24 часа, МСК', 'bt-lanes'),
    ctx.chart((w) => lanes(w, laneRows(s, now), now), 'lanes-host'),
    fold(
      [h('span', { class: 'muted' }, 'Обозначения')],
      [legend([
        { sw: 'sw-chat', text: 'чат' }, { sw: 'sw-bg', text: 'фоновый ход' }, { sw: 'sw-err', text: 'ошибка' },
        { sw: 'sw-live', text: 'идёт сейчас' }, { sw: 'sw-gap', text: 'пропуск' },
        { sw: null, text: 'наведение или стрелки на ленте — что, когда, сколько' },
      ])],
      { class: 'fold fold-legend' },
    )));
  return root;
}
