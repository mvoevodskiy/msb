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
      h('table', { class: 'tbl usage-table' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Период'), h('th', { scope: 'col' }, 'Без кеша'),
          h('th', { scope: 'col' }, 'Из кеша'), h('th', { scope: 'col' }, 'Всего'))),
        h('tbody', null, [['week', '7 дней'], ['month', '30 дней'], ['all', 'Всё время']].map(([key, label]) =>
          h('tr', null, h('th', { scope: 'row' }, label),
            h('td', null, tokens(bot.codexUsage.withoutCache?.[key])),
            h('td', null, tokens(bot.codexUsage.cacheRead?.[key])),
            h('td', null, tokens(bot.codexUsage[key])))))),
      bot.codexUsage.incomplete ? h('p', { class: 'muted small' }, 'Учтены доступные данные; история может быть неполной.') : null,
      bot.codexUsage.updatedAt ? h('p', { class: 'muted small' }, 'Обновлено ', fmtAgo(Math.max(0, (now - Date.parse(bot.codexUsage.updatedAt)) / 1000))) : null)),
    h('p', { class: 'note' }, `По календарным дням (${entries[0].codexUsage.timezone}). Учтены доступные фоновые задачи. Без кеша — ввод, не прочитанный из кеша, и ответ модели; из кеша — повторно использованный ввод.`),
    h('p', { class: 'note' }, 'При оплате по токенам ставки ввода и ответа различаются; чтение кеша обычно дешевле обычного ввода. Тариф зависит от модели и плана. Здесь показаны токены, а не стоимость или остаток подписки.'));
}
