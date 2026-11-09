/**
 * Saved once/reminder → single plain Telegram send → spent state and run log.
 * Called by [scheduler](./scheduler.mjs), never starts a CLI turn.
 * [Store](./reminder-store.mjs), [old flags](./reminder-policy.mjs),
 * [isolated worker/scheduler test](../../tests/one-shot-reminder.test.mjs).
 */
import { loadState } from '../state.mjs';
import { singleRequestSignal } from '../telegram/presentation-api.mjs';
import { readReminderPolicy, reminderOwnerChat } from './reminder-policy.mjs';
import { withAutonomyPauseLock } from './owner-pause.mjs';
import { appendReminderRun } from './reminder-runs.mjs';
import { claimReminder, finishReminder, reminderSnapshot } from './reminder-store.mjs';

export function createReminderDispatcher({ api, adminId, now, log }) {
  let boundChat;
  async function destination(isStopped) {
    if (isStopped() || !api || !adminId) return;
    const { state } = await loadState();
    const chat = reminderOwnerChat(state, adminId);
    if (!chat) return;
    const policy = await readReminderPolicy(state);
    if (!policy.enabled || !policy.local || policy.stopped || policy.asleep || isStopped()) return;
    // The old local runner is wired to the saved owner chat when it starts.
    boundChat ??= chat;
    return boundChat;
  }

  return async function dispatchReminders(isStopped) {
    const chat = await destination(isStopped);
    if (!chat) return;
    const { file, actions } = await reminderSnapshot();
    for (const snapshot of actions) {
      if (isStopped()) break;
      const millis = now();
      if (!snapshot.enabled || snapshot.lastRunAt || snapshot.budget?.killSwitch ||
          snapshot.disabledReason === 'frequency' || Date.parse(snapshot.trigger.at) > millis) continue;
      const ts = new Date(millis).toISOString();
      try {
        const action = await withAutonomyPauseLock(() =>
          claimReminder(file, snapshot, ts, { canRun: () => destination(isStopped) }));
        if (!action) continue;
        const result = await sendReminder(api, chat, action.task.text);
        await finishReminder(file, action, result).catch(error => {
          log('[msb/reminder] Could not save delivery result: ' + (error.code || error.name));
        });
        await appendReminderRun(action, ts, result);
      } catch (error) {
        log('[msb/reminder] Could not process saved action: ' + (error.code || error.name));
      }
    }
  };
}

async function sendReminder(api, chat, text) {
  try {
    await api.sendMessage(chat, '⏰ ' + text, undefined, singleRequestSignal(AbortSignal.timeout(15_000)));
    return { status: 'ok' };
  } catch {
    return { status: 'error', error: 'не удалось отправить напоминание' };
  }
}
