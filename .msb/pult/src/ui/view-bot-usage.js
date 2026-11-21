// Per-bot Codex usage on [Bots](./view-bots.js); numbers come from the collector snapshot.
import { h } from './dom.js';
import { secTitle } from './parts.js';
import { fmtAgo, fmtTokens } from './logic.js';

const tokens = value => typeof value === 'number' && Number.isFinite(value) ? fmtTokens(value, true) : 'Недоступно';

export function botUsageSection(bots, now) {
  const entries = bots.filter(bot => bot.codexUsage?.providerId === 'codex');
  if (!entries.length) return null;
  return h('section', { class: 'sec', 'aria-labelledby': 'bt-usage' },
    secTitle('Расход токенов · Codex', 'bt-usage'),
    entries.map(bot => h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('b', null, bot.name)),
      h('dl', { class: 'pk' },
        h('div', null, h('dt', null, '7 дней'), h('dd', null, tokens(bot.codexUsage.week))),
        h('div', null, h('dt', null, '30 дней'), h('dd', null, tokens(bot.codexUsage.month))),
        h('div', null, h('dt', null, 'Всё время'), h('dd', null, tokens(bot.codexUsage.all)))),
      bot.codexUsage.incomplete ? h('p', { class: 'muted small' }, 'Учтены доступные данные; история может быть неполной.') : null,
      bot.codexUsage.updatedAt ? h('p', { class: 'muted small' }, 'Обновлено ', fmtAgo(Math.max(0, (now - Date.parse(bot.codexUsage.updatedAt)) / 1000))) : null)),
    h('p', { class: 'note' }, `По календарным дням (${entries[0].codexUsage.timezone}). Включены кешированные токены и доступные фоновые задачи; это не остаток подписки.`));
}
