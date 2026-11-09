/**
 * Old /cost report and Settings → daily API limit. Read saved numbers only.
 * [Owner-day data](../../billing/owner-spend.mjs), [settings writes](../routes/settings.mjs),
 * [Telegram command](../bot.mjs), [checks](../../../tests/owner-spend.test.mjs).
 */
import { InlineKeyboard } from 'grammy';
import { savedOwnerSpend, SPEND_LIMIT_CHOICES } from '../../billing/owner-spend.mjs';
import { BLANK, describeSpendLimit } from './shared.mjs';

function position({ today, limit }, code = false) {
  if (today === undefined) return 'нет сохранённых данных';
  const total = '$' + today.toFixed(2);
  const shown = code ? '<code>' + total + '</code>' : total;
  if (limit === undefined) return shown;
  return shown + ' из ' + (limit > 0 ? '$' + limit : '∞');
}

function needsLimitLine({ today, limit }) {
  return today === undefined || limit === undefined;
}

export function costScreen(state, at = Date.now()) {
  const view = savedOwnerSpend(state, at);
  const lines = ['<b>💰 Расходы</b>', '', 'Сегодня: ' + position(view, true)];
  if (needsLimitLine(view)) lines.push('Сохранённый лимит: ' + describeSpendLimit(state.dailySpendLimit) + '.');
  if (view.recent.length) {
    lines.push('', '<b>Последние дни:</b>');
    for (const [day, amount] of view.recent) {
      lines.push((day === view.day ? '▸' : ' ') + ' ' + day + ': <code>$' + amount.toFixed(2) + '</code>');
    }
  }
  lines.push('', '<i>Сохранённые расходы движка агента. Deepgram и X API учитываются отдельно.</i>');
  return { text: lines.join('\n') };
}

export function limitScreen(state, at = Date.now()) {
  const view = savedOwnerSpend(state, at);
  const keyboard = new InlineKeyboard();
  for (const limit of SPEND_LIMIT_CHOICES) {
    const label = limit === 0 ? '∞ без лимита' : '$' + limit + '/день';
    keyboard.text(limit === view.limit ? '[' + label + ']' : label, 'settings:limit:set:' + limit).row();
  }
  keyboard.text('« Назад', 'settings:back');
  const lines = [
    '<b>💰 Лимит расходов</b>', '',
    'Настройка дневного лимита для <b>Anthropic API-ключа</b>. Бот учитывает сохранённую паузу.',
    'Автоматический учёт новых API-списаний пока недоступен.',
    '',
    'Подписки (<b>Claude</b>, <b>OpenAI</b>) и <b>OpenRouter</b> учитываются у провайдера.',
    '',
    'Сейчас: ' + position(view),
  ];
  if (needsLimitLine(view)) lines.push('Сохранённый лимит: ' + describeSpendLimit(state.dailySpendLimit) + '.');
  lines.push(BLANK);
  return { text: lines.join('\n'), keyboard };
}
