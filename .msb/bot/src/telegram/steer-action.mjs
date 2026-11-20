/**
 * Explicit queued correction for [inbox](./inbox.mjs) and [bot callbacks](./router.mjs).
 * The active Codex handle belongs to [turn](../agent/turn.mjs); no new model
 * turn is started here. Voice preparation → [steer voice](./steer-voice.mjs).
 * Confirmed corrections → [turn history](./history.mjs); checks: [races](../../tests/steer-action.test.mjs), [journal](../../tests/steer-history.test.mjs).
 * A failed Telegram file acquisition ends only that entry before STT. [FIFO regression](../../tests/steer-telegram.test.mjs).
 */
import { isAdmin } from './auth.mjs';
import { textPrompt } from './inbox.mjs';

export function createSteerAction({ inbox, getActive, adminId, prepareVoice, present, refresh, voiceNotConfigured }) {
  const answer = (ctx, text) => ctx.answerCallbackQuery(text ? { text } : {}).catch(() => {});
  return async function handleSteer(ctx) {
    if (!isAdmin(ctx, adminId)) return;
    const data = ctx.callbackQuery?.data || '';
    const token = data.startsWith('steer:') ? data.slice(6) : '';
    const message = ctx.callbackQuery?.message;
    const chatId = ctx.chat?.id, threadId = message?.message_thread_id || 1;
    const turn = getActive(chatId, threadId), handle = turn?.steer;
    if (!handle?.active || turn.controller.signal.aborted) return answer(ctx, 'Этот ход уже завершён.');
    const offered = inbox.steerEntries().find(row => row.entry.steerOffer?.token === token &&
      row.entry.steerOffer?.turn === turn && row.entry.steerOffer?.handle === handle);
    if (!offered) return answer(ctx, 'Это сообщение уже обрабатывается или удалено.');
    const reservation = inbox.reserveForSteer({ token: offered.token, chatId, threadId, messageId: message?.message_id });
    if (!reservation) return answer(ctx, 'Это сообщение уже обрабатывается или удалено.');
    void answer(ctx);
    refresh();
    const entry = reservation.entry;
    const signal = AbortSignal.any([reservation.signal, turn.controller.signal]);
    let preparingVoice = false, sending = false, ticket;
    const stillCurrent = () => !signal.aborted && reservation.isCurrent() && getActive(chatId, threadId) === turn &&
      turn.steer === handle && handle.active;
    const current = async () => stillCurrent() && await handle.isCurrent() && stillCurrent();
    try {
      await present(entry, entry.voice ? '🎙 Расшифровываю...' : 'Передаю в текущий ход...');
      if (!await current()) { reservation.release(); return; }
      let prompt, input;
      if (entry.voice) {
        preparingVoice = !entry.preparedVoice;
        const recognized = entry.preparedVoice || await prepareVoice(entry, signal);
        preparingVoice = false;
        prompt = recognized.prompt;
        input = recognized.transcript;
      } else { prompt = textPrompt(entry); input = entry.text; }
      if (!await current()) { reservation.release(); return; }
      ticket = turn.history?.reserveSteer(input);
      if (!ticket) { reservation.release(); return; }
      sending = true;
      const result = await handle.steer(prompt);
      ticket.settle(result?.status);
      if (!reservation.isCurrent()) return;
      if (result?.status === 'accepted') {
        reservation.consume();
        await present(entry, 'Передано в текущий ход.');
      } else if (result?.status === 'rejected' || result?.status === 'unavailable') {
        reservation.release();
      } else {
        reservation.unknown();
        entry.steerUnknown = true;
        await present(entry, 'Не удалось подтвердить передачу. Сообщение не будет отправлено повторно автоматически.\n\nОчередь приостановлена. /stop остановит текущий ход и очистит очередь.');
      }
    } catch (error) {
      ticket?.settle('unknown');
      if (reservation.isCurrent()) {
        if (preparingVoice && error?.code === 'TELEGRAM_VOICE_FILE_UNAVAILABLE') {
          reservation.consume();
          await present(entry, `❌ Не удалось обработать голосовое: ${error.message}\n\nПопробуй ещё раз или напиши текстом.`).catch(() => {});
        } else if (sending || (preparingVoice && error?.code !== 'STT_NOT_CONFIGURED' && !entry.preparedVoice)) {
          reservation.unknown();
          entry.steerUnknown = true;
          await present(entry, sending
            ? 'Не удалось подтвердить передачу. Сообщение не будет отправлено повторно автоматически.\n\nОчередь приостановлена. /stop остановит текущий ход и очистит очередь.'
            : 'Не удалось подтвердить обработку голосового. Повторной отправки не будет.\n\nОчередь приостановлена. /stop остановит текущий ход и очистит очередь.').catch(() => {});
        } else {
          const notifyVoice = !signal.aborted && error?.code === 'STT_NOT_CONFIGURED';
          reservation.release();
          if (notifyVoice) await voiceNotConfigured?.(entry).catch(() => {});
        }
      }
    } finally { ticket?.settle('unknown'); refresh(); }
  };
}
