/**
 * Saved literal reminder → [gate](./reminder-admission.mjs) → committed attempt
 * → single plain Telegram send or refusal → [run log](./reminder-runs.mjs).
 * [Scheduler](./scheduler.mjs) calls it without starting a CLI turn.
 * [Store](./reminder-store.mjs) records delivery and [breaker](./reminder-breaker.mjs)
 * transitions. [Pause lock](./owner-pause.mjs), [checks](../../tests/reminder-limits.test.mjs).
 */
import { loadState, NO_STATE_WRITE, updateState } from '../state.mjs';
import { singleRequestSignal } from '../telegram/presentation-api.mjs';
import { isLocalReminderEngine, readReminderPolicy, reminderOwnerChat } from './reminder-policy.mjs';
import { withAutonomyPauseLock } from './owner-pause.mjs';
import { currentReminderRefusal, readBoxReminderRefusal } from './reminder-admission.mjs';
import { readReminderBreakerRefusal } from './reminder-breaker.mjs';
import { reminderBreakerNotice } from './reminder-breaker-notice.mjs';
import { reminderIsDue } from './reminder-schedule.mjs';
import { readReminderFrequencyDecisions, reminderFrequencyAllows } from './reminder-frequency.mjs';
import { appendReminderRun } from './reminder-runs.mjs';
import { claimReminder, finishReminder, reminderSnapshot } from './reminder-store.mjs';

export function createReminderDispatcher({ api, adminId, timezone, now, log }) {
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
    return { chat: boundChat, reserveFraction: policy.reserveFraction, timezone: state.timezone || timezone };
  }

  async function admit(action, slotAt, ts, boxRefusal, publish, isStopped) {
    const target = await destination(isStopped);
    if (!target) return;
    let admitted;
    // The provider and owner's saved spend are sampled after journal I/O.
    // Serialize the short commit with the in-process engine/provider updates.
    await updateState(async state => {
      if (isStopped() || !isLocalReminderEngine(state.engine) || !reminderOwnerChat(state, adminId)) return NO_STATE_WRITE;
      if (!reminderIsDue(action, slotAt, state.timezone || timezone)) return NO_STATE_WRITE;
      const decisions = action.trigger.kind === 'once' ? undefined : await readReminderFrequencyDecisions();
      if (!reminderFrequencyAllows(action, decisions)) return NO_STATE_WRITE;
      const breaker = await readReminderBreakerRefusal(action.id, ts);
      if (isStopped()) return NO_STATE_WRITE;
      const refusal = breaker ?? boxRefusal ?? currentReminderRefusal(action, state, ts, target.reserveFraction);
      const claimed = await publish(refusal);
      admitted = { action: claimed, chat: target.chat, refusal };
      return NO_STATE_WRITE;
    });
    return admitted;
  }

  return async function dispatchReminders(isStopped) {
    const target = await destination(isStopped);
    if (!target) return;
    const { file, actions } = await reminderSnapshot();
    // Old nwA selected every due row at one instant. Rz separately stamped
    // each attempt as it started, even if an earlier send crossed the minute.
    const slotAt = now();
    for (const snapshot of actions) {
      if (isStopped()) break;
      if (!reminderIsDue(snapshot, slotAt, target.timezone)) continue;
      const ts = new Date(now()).toISOString();
      try {
        // Old shared journals can be slow. Read them before locking the local
        // pause, then recheck that both the action and route can still run.
        const boxRefusal = await readBoxReminderRefusal(ts);
        const admitted = await withAutonomyPauseLock(() =>
          claimReminder(file, snapshot, ts, {
            admit: (action, publish) => admit(action, slotAt, ts, boxRefusal, publish, isStopped),
          }));
        if (!admitted) continue;
        const { action, chat, refusal } = admitted;
        const result = refusal ?? await sendReminder(api, chat, action.task.text);
        const completion = refusal ? undefined
          : await finishReminder(file, action, result).catch(actionError => ({ actionError }));
        if (completion?.actionError) {
          const error = completion.actionError;
          log('[msb/reminder] Could not save delivery result: ' + (error.code || error.name));
        }
        if (completion?.breakerError) {
          const error = completion.breakerError;
          log('[msb/reminder] Could not save reminder breaker: ' + (error.code || error.name));
        }
        await appendReminderRun(action, ts, result).catch(error => {
          log('[msb/reminder] Could not append run: ' + (error.code || error.name));
        });
        if (refusal?.status === 'blocked') {
          await sendText(api, chat, '📡 Автономное действие «' + action.name + '» приостановлено: ' + refusal.detail)
            .catch(() => log('[msb/reminder] Could not send the limit notice'));
        } else if (completion?.event) {
          await sendText(api, chat, reminderBreakerNotice(completion.event, action, ts))
            .catch(() => log('[msb/reminder] Could not send the breaker notice'));
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
