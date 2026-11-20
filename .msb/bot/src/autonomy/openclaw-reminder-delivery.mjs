/**
 * Durable delivery for a mapped [native one-shot](./openclaw-reminder-dispatch.mjs).
 * The payload comes from the saved action, never the model. The [map](./native-job-map.mjs)
 * records pending delivery before the once-run [history](./reminder-runs.mjs).
 */
import { singleRequestSignal } from '../telegram/presentation-api.mjs';
import { appendSavedActionRun } from './reminder-runs.mjs';
import { readNativeReminderFinish } from './openclaw-reminder-cron.mjs';

const maxAttempts = 8;
const measured = (...values) => values.find(value => Number.isSafeInteger(value) && value >= 0);

export async function readNativeReminderDelivery(gateway, entry, action, ownerChat, now, signal) {
  if (!entry.awaitingRunAtMs && !(now >= Date.parse(action.trigger.at))) return;
  const terminal = await readNativeReminderFinish(gateway, entry, signal);
  if (!terminal) return terminal;
  if (terminal.status === 'error' && terminal.error === 'Cron job disabled by operator.') {
    return { runAtMs: terminal.runAtMs, status: 'stopped' };
  }
  const origin = action.origin;
  const usage = terminal.usage ?? {};
  const tokensIn = measured(usage.input, usage.inputTokens, usage.input_tokens, usage.prompt);
  const tokensOut = measured(usage.output, usage.outputTokens, usage.output_tokens, usage.completion);
  return { runAtMs: terminal.runAtMs, chatId: origin?.chatId ?? ownerChat, threadId: origin?.threadId,
    messageId: origin?.messageId, text: action.task.text, attempts: 0, status: 'pending', tokensIn, tokensOut };
}

export async function sendNativeReminder(api, entry, persist, now) {
  const delivery = entry.delivery;
  if (delivery.status !== 'pending' || delivery.retryAt > now) return;
  const options = {
    ...(delivery.threadId ? { message_thread_id: delivery.threadId } : {}),
    ...(delivery.messageId ? { reply_parameters: { message_id: delivery.messageId, allow_sending_without_reply: true } } : {}),
  };
  try {
    await api.sendMessage(delivery.chatId, '⏰ ' + delivery.text, options,
      singleRequestSignal(AbortSignal.timeout(15_000)));
  } catch {
    delivery.attempts += 1;
    delivery.status = delivery.attempts < maxAttempts ? 'pending' : 'failed';
    delivery.retryAt = now + Math.min(3_600, 60 * 2 ** (delivery.attempts - 1)) * 1000;
    await persist();
    return;
  }
  delivery.status = 'sent';
  delete delivery.retryAt;
  await persist();
}

export async function recordNativeReminder(entry, action, save, env) {
  const { runAtMs, status, tokensIn, tokensOut } = entry.delivery;
  const lastRunAt = new Date(runAtMs).toISOString();
  const stopped = status === 'stopped';
  const outcome = stopped ? 'stopped' : 'ok';
  if (action.lastRunAt !== lastRunAt || action.lastOutcome !== outcome) {
    await save({ ...action, lastRunAt, lastStatus: stopped ? 'skipped' : 'ok', lastOutcome: outcome,
      lastError: undefined, enabled: false, disabledReason: 'spent_once' });
  }
  await appendSavedActionRun(action, lastRunAt, { status: outcome, nativeJobId: entry.jobId,
    detail: stopped ? 'остановил стоп-кран' : 'напоминание поставлено в очередь на доставку',
    tokensIn, tokensOut }, { env, costVisible: false });
}
