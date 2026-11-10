/** Forwarded text/voice preparation, using the same STT as a standalone voice. */
import { recognizeVoice } from './voice.mjs';
import { buildReplyContext } from './reply-context.mjs';
export function batchStatus(entry) {
  const count = entry.items.length, media = entry.items.filter(item => item.voice).length;
  const singular = count % 10 === 1 && count % 100 !== 11;
  const prefix = count < 2 ? '📥' : `📥 Принял ${count} ${singular ? 'пересланное' : 'пересланных'},`;
  return media ? `${prefix} ${count < 2 ? 'З' : 'з'}агружаю медиа (${media})…`
    : count < 2 ? 'Думаю ⏳' : `${prefix} читаю…`;
}
function origin(message) {
  const o = message.forward_origin;
  const user = o?.sender_user || message.forward_from;
  return o?.sender_user_name || o?.chat?.title || o?.sender_chat?.title || message.forward_from_chat?.title ||
    (user && [user.first_name, user.last_name].filter(Boolean).join(' ')) || 'источник неизвестен';
}
export async function prepareBatch(entry, botToken, signal) {
  const n = entry.items.length;
  const parts = [n === 1 ? 'Пользователь переслал сообщение:' : `Пользователь переслал пачку из ${n} сообщений. Обработай их ВМЕСТЕ, одним ответом — не по одному.`, ''];
  for (const [i, item] of entry.items.entries()) {
    signal.throwIfAborted();
    let transcript;
    if (item.voice) {
      try { transcript = (await recognizeVoice(item.ctx, botToken, signal)).transcript; }
      catch { signal.throwIfAborted(); /* Keep this position and all following messages. */ }
    }
    const duration = item.ctx.message?.voice?.duration;
    parts.push(`#${i + 1} [${item.comment ? 'комментарий пользователя' : origin(item.ctx.message)}]` +
      (item.voice ? ` — голосовое${duration ? ` ${duration}с` : ''}${transcript ? '' : ' (не расшифровано)'}` : ''));
    const context = buildReplyContext(item.ctx.message, item.ctx.me?.id);
    if (context) parts.push(context);
    if (item.text) parts.push(item.text);
    if (transcript) parts.push(`Расшифровка голосового: ${transcript}`);
    parts.push('');
  }
  if (entry.capHit) parts.push('⚠️ Пачка закрыта по лимиту 300 сообщений — остальное придёт отдельной пачкой.');
  return parts.join('\n').trimEnd();
}
