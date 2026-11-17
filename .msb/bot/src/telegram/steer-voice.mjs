/**
 * Prepare one reserved voice through the existing [voice route](./voice.mjs).
 * [Steer action](./steer-action.mjs) retains the result on the inbox item;
 * [executeTurn](./bot.mjs) reuses it if the item returns to the queue.
 */
import { recognizeVoice, voicePreview } from './voice.mjs';
import { presentationSignal } from './presentation-api.mjs';

export async function prepareQueuedSteerVoice(entry, botToken, signal, recognize = recognizeVoice) {
  if (entry.preparedVoice) return entry.preparedVoice;
  signal.throwIfAborted();
  const ctx = entry.ctx, thread = ctx.message?.message_thread_id;
  let transcription;
  try {
    transcription = await ctx.reply('🎙 Расшифровываю...', thread && thread !== 1 ? { message_thread_id: thread } : {},
      presentationSignal(AbortSignal.any([signal, AbortSignal.timeout(15_000)])));
    signal.throwIfAborted();
    const recognized = await recognize(ctx, botToken, signal);
    signal.throwIfAborted();
    const prepared = entry.preparedVoice = { ...recognized, transcription, previewDone: false };
    const preview = voicePreview(recognized.transcript);
    try {
      await ctx.api.editMessageText(ctx.chat.id, transcription.message_id, preview.html, { parse_mode: 'HTML' });
      prepared.previewDone = true;
    } catch {
      if (!signal.aborted) {
        try { await ctx.api.editMessageText(ctx.chat.id, transcription.message_id, preview.plain); prepared.previewDone = true; }
        catch { /* existing turn may retry the preview */ }
      }
    }
    return prepared;
  } finally {
    if (transcription && (!entry.preparedVoice || signal.aborted)) {
      await ctx.api.deleteMessage(ctx.chat.id, transcription.message_id, presentationSignal(AbortSignal.timeout(15_000))).catch(() => {});
    }
  }
}
