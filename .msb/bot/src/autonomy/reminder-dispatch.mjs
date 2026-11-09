/**
 * Saved local action → [gate](./reminder-admission.mjs) → committed attempt
 * → literal Telegram send or [isolated Claude](./prompt-turn.mjs) → [run log](./reminder-runs.mjs).
 * [Scheduler](./scheduler.mjs) drains this pass on shutdown.
 * [Store](./reminder-store.mjs) records delivery and [breaker](./reminder-breaker.mjs)
 * transitions. [Pause lock](./owner-pause.mjs), [checks](../../tests/reminder-limits.test.mjs).
 */
import { loadState, NO_STATE_WRITE, updateState } from '../state.mjs';
import { singleRequestSignal } from '../telegram/presentation-api.mjs';
import { isLocalReminderEngine, readReminderPolicy, reminderOwnerChat } from './reminder-policy.mjs';
import { trackAutonomyTurn, withAutonomyPauseLock } from './owner-pause.mjs';
import { currentReminderRefusal, readBoxReminderRefusal } from './reminder-admission.mjs';
import { readReminderBreakerRefusal } from './reminder-breaker.mjs';
import { reminderBreakerNotice } from './reminder-breaker-notice.mjs';
import { reminderIsDue } from './reminder-schedule.mjs';
import { readReminderFrequencyDecisions, reminderFrequencyAllows } from './reminder-frequency.mjs';
import { appendSavedActionRun } from './reminder-runs.mjs';
import { claimSavedAction, finishSavedAction, savedActionClaimIsCurrent, savedActionSnapshot } from './reminder-store.mjs';
import { savedPromptPlan } from './prompt-policy.mjs';
import { runSavedClaudePrompt } from './prompt-turn.mjs';
import { deliverSavedPrompt } from './prompt-delivery.mjs';

export function createReminderDispatcher({ api, adminId, timezone, now, log, signal }) {
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
    return { chat: boundChat, reserveFraction: policy.reserveFraction, timezone: state.timezone || timezone, state };
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
      const plan = action.task.kind === 'prompt' ? savedPromptPlan(action, state) : undefined;
      if (action.task.kind === 'prompt' && !plan) return NO_STATE_WRITE;
      const decisions = action.trigger.kind === 'once' ? undefined : await readReminderFrequencyDecisions();
      if (!reminderFrequencyAllows(action, decisions)) return NO_STATE_WRITE;
      const breaker = await readReminderBreakerRefusal(action.id, ts);
      if (isStopped()) return NO_STATE_WRITE;
      const refusal = breaker ?? boxRefusal ?? currentReminderRefusal(action, state, ts, target.reserveFraction);
      const claimed = await publish(refusal);
      admitted = { action: claimed, chat: target.chat, refusal, plan };
      return NO_STATE_WRITE;
    });
    return admitted;
  }

  async function promptOutcome(file, action, chat, plan, turn) {
    const active = AbortSignal.any([turn.signal, signal]);
    try {
      const result = await runSavedClaudePrompt(action, plan, {
        signal: active, isCurrent: () => savedActionClaimIsCurrent(file, action),
      }).catch(() => ({
        status: 'deferred', detail: 'не удалось подготовить изолированный запуск',
      }));
      if (active.aborted) return { status: 'stopped', detail: 'ход прерван остановкой фоновых задач' };
      return await deliverSavedPrompt(api, chat, result, active);
    } finally {
      turn.release();
    }
  }

  return async function dispatchReminders(isStopped) {
    const target = await destination(isStopped);
    if (!target) return;
    const { file, actions } = await savedActionSnapshot();
    // Old nwA selected every due row at one instant. Rz separately stamped
    // each attempt as it started, even if an earlier send crossed the minute.
    const slotAt = now();
    for (const snapshot of actions) {
      if (isStopped()) break;
      if (!reminderIsDue(snapshot, slotAt, target.timezone) ||
          (snapshot.task.kind === 'prompt' && !savedPromptPlan(snapshot, target.state))) continue;
      const ts = new Date(now()).toISOString();
      try {
        // Old shared journals can be slow. Read them before locking the local
        // pause, then recheck that both the action and route can still run.
        const boxRefusal = await readBoxReminderRefusal(ts);
        const admitted = await withAutonomyPauseLock(async () => {
          const claim = await claimSavedAction(file, snapshot, ts, {
            admit: (action, publish) => admit(action, slotAt, ts, boxRefusal, publish, isStopped),
          });
          if (claim?.plan && !claim.refusal) claim.turn = trackAutonomyTurn();
          return claim;
        });
        if (!admitted) continue;
        const { action, chat, refusal, turn, plan } = admitted;
        const result = refusal ?? (turn ? await promptOutcome(file, action, chat, plan, turn)
          : await sendReminder(api, chat, action.task.text));
        const completion = refusal ? undefined
          : await finishSavedAction(file, snapshot, action, result).catch(actionError => ({ actionError }));
        if (completion?.actionError) {
          const error = completion.actionError;
          log('[msb/reminder] Could not save delivery result: ' + (error.code || error.name));
        }
        if (completion?.breakerError) {
          const error = completion.breakerError;
          log('[msb/reminder] Could not save reminder breaker: ' + (error.code || error.name));
        }
        if (result.status === 'deferred') continue;
        await appendSavedActionRun(action, ts, result).catch(error => {
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
