/**
 * Telegram download, reply-context и прежний preview голоса.
 * Навигация: [Голос](./README.md#голос) → [STT backend](../media/README.md).
 */
import { resolveSttConfig, transcribeVoice, audioTimeoutMs } from '../media/stt.mjs';
import { buildReplyContext } from './reply-context.mjs';
import { escapeHtml } from './edit.mjs';

export function voicePreview(text) {
  let end = 300;
  if (text.length > end && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
  const preview = text.length > 300 ? text.slice(0, end) + '...' : text;
  return { html: `<blockquote>${escapeHtml(preview)}</blockquote>\n🎙 •~•~•~•~•~•~•~•~•~•~•`, plain: `${preview}\n🎙 •~•~•~•~•~•~•~•~•~•~•` };
}
export const STT_ONBOARDING = {
  text: '🎙 Голосовые пока не настроены.\n\nПодключи Deepgram — при регистрации дают $200 баланса, хватит надолго. Нажми кнопку: останется перейти на сайт и вставить ключ.',
  reply_markup: { inline_keyboard: [[{ text: '🎤 Подключить Deepgram', callback_data: 'settings:env:quick:DEEPGRAM_API_KEY' }], [{ text: 'Не сейчас', callback_data: 'whisper:skip' }]] },
};

export async function recognizeVoice(ctx, botToken, signal) {
  signal.throwIfAborted();
  await resolveSttConfig(); // Fail before downloading when no STT provider is configured.
  signal.throwIfAborted();
  let file;
  try { file = await ctx.api.getFile(ctx.message.voice.file_id, signal); }
  catch { signal.throwIfAborted(); throw Error('Не удалось получить голосовое из Telegram'); }
  signal.throwIfAborted();
  const timeout = audioTimeoutMs(file.file_size);
  let bytes;
  try {
    if (!file.file_path) throw Error('Не удалось скачать voice: нет пути файла');
    const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    if (!response.ok) throw Error(`Не удалось скачать voice: HTTP ${response.status}`);
    bytes = await response.arrayBuffer();
  } catch (err) {
    signal.throwIfAborted();
    if (err.name === 'TimeoutError') throw Error(`Телеграм не ответил за ${Math.round(timeout / 1000)} с`);
    // Do not surface a transport URL containing the bot token.
    throw Error(/^Не удалось скачать voice:/.test(err.message) ? err.message : 'Не удалось скачать voice');
  }
  signal.throwIfAborted();
  const transcript = await transcribeVoice(bytes, { signal });
  signal.throwIfAborted();
  const context = buildReplyContext(ctx.message, ctx.me?.id);
  return { transcript, prompt: context ? `${context}\n\n${transcript}` : transcript };
}
