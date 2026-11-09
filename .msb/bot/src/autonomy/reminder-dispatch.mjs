/**
 * Saved once/reminder → [gate](./reminder-admission.mjs) → committed attempt
 * → single plain Telegram send or refusal → [run log](./reminder-runs.mjs).
 * [Scheduler](./scheduler.mjs) calls it without starting a CLI turn.
 * [Store](./reminder-store.mjs), [pause lock](./owner-pause.mjs),
 * [checks](../../tests/reminder-limits.test.mjs).
 */
import { loadState, NO_STATE_WRITE, updateState } from '../state.mjs';
import { singleRequestSignal } from '../telegram/presentation-api.mjs';
import { isLocalReminderEngine, readReminderPolicy, reminderOwnerChat } from './reminder-policy.mjs';
import { withAutonomyPauseLock } from './owner-pause.mjs';
import { currentReminderRefusal, readReminderRefusal } from './reminder-admission.mjs';
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
    return { chat: boundChat, reserveFraction: policy.reserveFraction };
  }

  async function admit(action, ts, earlyRefusal, publish, isStopped) {
    const target = await destination(isStopped);
    if (!target) return;
    let admitted;
    // The provider and owner's saved spend are sampled after journal I/O.
    // Serialize the short commit with the in-process engine/provider updates.
    await updateState(async state => {
      if (isStopped() || !isLocalReminderEngine(state.engine) || !reminderOwnerChat(state, adminId)) return NO_STATE_WRITE;
      const refusal = earlyRefusal ?? currentReminderRefusal(action, state, ts, target.reserveFraction);
      const claimed = await publish(refusal);
      admitted = { action: claimed, chat: target.chat, refusal };
      return NO_STATE_WRITE;
    });
    return admitted;
  }

  return async function dispatchReminders(isStopped) {
    if (!await destination(isStopped)) return;
    const { file, actions } = await reminderSnapshot();
    for (const snapshot of actions) {
      if (isStopped()) break;
      const millis = now();
      if (!snapshot.enabled || snapshot.lastRunAt || snapshot.budget?.killSwitch ||
          snapshot.disabledReason === 'frequency' || Date.parse(snapshot.trigger.at) > millis) continue;
      const ts = new Date(millis).toISOString();
      try {
        // Old shared journals can be slow. Read them before locking the local
        // pause, then recheck that both the action and route can still run.
        const earlyRefusal = await readReminderRefusal(snapshot, ts);
        const admitted = await withAutonomyPauseLock(() =>
          claimReminder(file, snapshot, ts, {
            admit: (action, publish) => admit(action, ts, earlyRefusal, publish, isStopped),
          }));
        if (!admitted) continue;
        const { action, chat, refusal } = admitted;
        const result = refusal ?? await sendReminder(api, chat, action.task.text);
        if (!refusal) {
          await finishReminder(file, action, result).catch(error => {
            log('[msb/reminder] Could not save delivery result: ' + (error.code || error.name));
          });
        }
        await appendReminderRun(action, ts, result).catch(error => {
          log('[msb/reminder] Could not append run: ' + (error.code || error.name));
        });
        if (refusal?.status === 'blocked') {
          await sendText(api, chat, '📡 Автономное действие «' + action.name + '» приостановлено: ' + refusal.detail)
            .catch(() => log('[msb/reminder] Could not send the limit notice'));
        }
      } catch (error) {
        log('[msb/reminder] Could not process saved action: ' + (error.code || error.name));
      }
    }
  };
}

function sendText(api, chat, text) {
  return api.sendMessage(chat, text, undefined, singleRequestSignal(AbortSignal.timeout(15_000)));
}

async function sendReminder(api, chat, text) {
  try {
    await sendText(api, chat, '⏰ ' + text);
    return { status: 'ok' };
  } catch {
    return { status: 'error', error: 'не удалось отправить напоминание' };
  }
}
