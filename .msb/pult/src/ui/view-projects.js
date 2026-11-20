// Экран «Проекты» (v3): сначала «От тебя», детали — по раскрытию.

import { h } from './dom.js';
import { pageTitle, empty, levelDot, fold } from './parts.js';
import { projectLevel, projectServicesParts, count, fmtWhen } from './logic.js';

const LEVEL_CLS = { crit: 'red', serious: 'orange', warn: 'amber', off: 'muted' };

export function viewProjects(ctx) {
  const { s, now } = ctx;
  const root = h('div', { class: 'projects' }, pageTitle('Проекты'));
  if (!s.projects.length) { root.append(empty('Проектов нет', 'Боты заводят карточки командой pult project …')); return root; }

  const sorted = [...s.projects].sort((a, b) => {
    const aa = a.asks.length ? 1 : 0, bb = b.asks.length ? 1 : 0;
    if (bb !== aa) return bb - aa;
    const wa = projectLevel(a) === 'pause' ? 1 : 0;
    const wb = projectLevel(b) === 'pause' ? 1 : 0;
    if (wa !== wb) return wa - wb;
    return a.name.localeCompare(b.name, 'ru');
  });

  root.append(h('ul', { class: 'proj-grid' }, sorted.map((p) => {
    const lvl = projectLevel(p);
    const rows = [];
    const row = (k, ...v) => rows.push(h('div', null, h('dt', null, k), h('dd', null, ...v)));
    if (p.stage) row('Этап', p.stage);
    const svc = projectServicesParts(p, s.services);
    if (svc.length) row('Службы', ...svc.flatMap((x, i) => [i ? ' · ' : null, h('span', { class: LEVEL_CLS[x.level] ?? null }, x.text)]));
    for (const f of p.facts) row(f.label, f.value);
    if (p.commitsToday != null) {
      row('Сегодня', p.commitsToday ? count(p.commitsToday, 'коммит', 'коммита', 'коммитов') : h('span', { class: 'muted' }, 'коммитов нет'),
        p.lastCommit ? h('span', { class: 'muted small block' }, `последний ${fmtWhen(p.lastCommit.at, now)}: ${p.lastCommit.subject}`) : null);
    }
    if (p.next) row('Дальше', p.next);
    if (p.asks.length) row('От тебя', h('span', { class: 'red' }, p.asks.join(', ')));

    const hot = p.asks.length > 0;
    const compact = !hot && (lvl === 'good' || lvl === 'pause');
    const head = h('div', { class: 'card-head' },
      h('h2', { class: 'pname' }, levelDot(lvl), ' ', p.name),
      h('span', { class: lvl === 'pause' ? 'muted' : 'ink2' }, p.statusText));

    const askLine = hot ? h('div', { class: 'ask-line' }, `От тебя · ${p.asks.length}`) : null;
    const owner = h('div', { class: 'muted small owner' }, p.owner || 'без бота');
    const upd = p.updatedAt ? h('div', { class: 'muted small upd' }, `карточка обновлена ${fmtWhen(p.updatedAt, now)}`) : null;

    if (compact) {
      return h('li', { class: `card proj compact${lvl === 'pause' ? ' paused' : ''}` },
        head,
        askLine,
        fold(
          [h('span', { class: 'muted' }, 'Подробнее')],
          [owner, rows.length ? h('dl', { class: 'pk' }, rows) : null, upd],
          { class: 'fold fold-proj' },
        ));
    }

    return h('li', { class: `card proj${hot ? ' hot' : ''}${lvl === 'pause' ? ' paused' : ''}` },
      head,
      askLine,
      owner,
      rows.length ? h('dl', { class: 'pk' }, rows) : null,
      upd);
  })));
  return root;
}
