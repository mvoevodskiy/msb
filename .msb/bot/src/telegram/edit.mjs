import { GrammyError } from 'grammy';
import { callbackTransportSignal } from '../../shared/callback-renders.mjs';

export async function editOrReply(api, chatId, messageId, text, keyboard, parseMode = 'HTML', scope, extra = {}) {
  const deliver = async () => {
    if (scope && !scope.isCurrent()) return;
    const { message_thread_id, ...editOptions } = extra;
    const opts = { ...editOptions, parse_mode: parseMode, reply_markup: keyboard };
    if (messageId) {
      try {
        return await api.editMessageText(chatId, messageId, text, opts, scope ? callbackTransportSignal(scope) : undefined);
      } catch (err) {
        if (scope && !scope.isCurrent()) return;
        if (err instanceof GrammyError && /not modified/i.test(err.description || '')) return;
      }
    }
    if (!scope || scope.isCurrent()) {
      const reply = message_thread_id ? { ...opts, message_thread_id } : opts;
      return await api.sendMessage(chatId, text, reply, scope ? callbackTransportSignal(scope) : undefined);
    }
  };
  return scope ? scope.render(deliver) : deliver();
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
