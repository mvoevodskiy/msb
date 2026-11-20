/**
 * The old frequency decision card. [Scheduler brake](../autonomy/reminder-frequency-brake.mjs)
 * offers it, [router](./router.mjs) records the owner's tap, and [decision book](../autonomy/frequency-decisions.mjs)
 * keeps the message binding and choice. Only the next eligible tick changes the action.
 */
import { reminderOwnerChat } from '../autonomy/reminder-policy.mjs';
import { reminderFrequencyChoices, reminderFrequencyFloor, reminderFrequencySubject } from '../autonomy/reminder-frequency.mjs';
import { proposeFrequencyDecision, settleFrequencyDecision } from '../autonomy/frequency-decisions.mjs';
import { escapeHtml } from './edit.mjs';
import { singleRequestSignal } from './presentation-api.mjs';

const emptyKeyboard = { inline_keyboard: [] };

function render(card) {
  return ['🧭 Решение', '<b>' + escapeHtml(card.title) + '</b>', escapeHtml(card.body),
    '<i>' + escapeHtml(card.producedBy) + '</i>'].join('\n\n');
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(15_000);
  return singleRequestSignal(signal ? AbortSignal.any([signal, timeout]) : timeout);
}

export async function askFrequencyDecision(api, chatId, action, minutes, { now, signal, isAllowed }) {
  const question = {
    subject: reminderFrequencySubject(action.id),
    title: 'Фоновая задача «' + action.name + '» срабатывает слишком часто',
    body: 'Сейчас она идёт каждые ' + minutes + ' мин, а нижняя граница ' + reminderFrequencyFloor +
      ' мин. Каждый запуск стоит денег, поэтому я снял её с расписания и жду твоего решения. Выбор запомню и больше спрашивать не буду.',
    producedBy: 'autonomy/pre-turn-brakes',
    options: reminderFrequencyChoices,
  };
  let sent;
  try {
    await proposeFrequencyDecision(question, { chatId, now, post: async card => {
      if (!await isAllowed()) return;
      const reply_markup = { inline_keyboard: card.options.map(({ value, label }) =>
        [{ text: label, callback_data: 'dc:' + card.shortId + ':' + value }]) };
      sent = await api.sendMessage(chatId, render(card), {
        parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup,
      }, requestSignal(signal));
      return sent?.message_id;
    } });
  } catch (error) {
    if (sent?.message_id) await api.editMessageReplyMarkup(chatId, sent.message_id, {
      reply_markup: emptyKeyboard,
    }, requestSignal()).catch(() => {});
    throw error;
  }
}

export function isFrequencyConfirmation(data) {
  return data.startsWith('dc:');
}

export async function handleFrequencyConfirmation({ ctx, cfg, data, chatId, msgId, state, now, answer }) {
  const ownerChat = reminderOwnerChat(state, cfg.adminId);
  if (!ownerChat) return answer({ text: 'Решение принимает только владелец бокса', show_alert: true });
  let decision;
  try {
    decision = await settleFrequencyDecision(data, { chatId, msgId, ownerChat, now });
  } catch {
    return answer({ text: 'Не смог записать решение, попробуй ещё раз', show_alert: true });
  }
  if (!decision) return answer({ text: 'Карточка устарела' });
  if (!decision.card) return answer({ text: 'Уже решено: ' + decision.label });
  const text = 'Решено: ' + decision.label;
  await ctx.api.editMessageText(chatId, msgId, render(decision.card) + '\n\n' + escapeHtml(text),
    { parse_mode: 'HTML', reply_markup: emptyKeyboard }, requestSignal()).catch(() => {});
  await answer({ text });
}
