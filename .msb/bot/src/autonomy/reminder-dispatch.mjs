/**
 * Saved local action → [gate](./reminder-admission.mjs) → committed attempt
 * → literal Telegram send or [isolated provider](./prompt-turn.mjs) → [run log](./reminder-runs.mjs).
 * [Frequency decisions](./reminder-frequency-brake.mjs) settle before due selection.
 * [Scheduler](./scheduler.mjs) drains this pass on shutdown.
 * [Store](./reminder-store.mjs) records delivery and [breaker](./reminder-breaker.mjs)
 * transitions. [Pause lock](./owner-pause.mjs), [checks](../../tests/reminder-limits.test.mjs).
 */
import { loadState, NO_STATE_WRITE, updateState } from '../state.mjs';
import { singleRequestSignal } from '../telegram/presentation-api.mjs';
import { isLocalReminderEngine, readReminderPolicy, reminderOwnerChat } from './reminder-policy.mjs';
import { trackAutonomyTurn, withAutonomyPauseLock } from './owner-pause.mjs';
import { currentReminderRefusal, readBoxReminderRefusal } from './reminder-admission.mjs';
import { codexQuotaRefusal } from './subscription-gate.mjs';
import { readReminderBreakerRefusal } from './reminder-breaker.mjs';
import { reminderBreakerNotice } from './reminder-breaker-notice.mjs';
import { reminderIsDue } from './reminder-schedule.mjs';
import { reminderFrequencyAllows } from './reminder-frequency.mjs';
import { readReminderFrequencyDecisions } from './frequency-decisions.mjs';
import { applyReminderFrequencyBrake } from './reminder-frequency-brake.mjs';
import { appendSavedActionRun } from './reminder-runs.mjs';
import { claimSavedAction, finishSavedAction, savedActionClaimIsCurrent, savedActionSnapshot } from './reminder-store.mjs';
import { savedPromptPlan } from './prompt-policy.mjs';
import { runSavedPrompt } from './prompt-turn.mjs';
import { deliverSavedPrompt } from './prompt-delivery.mjs';

export function createReminderDispatcher({ api, adminId, timezone, now, log, signal, runCodexPrompt, runCursorPrompt, readCodexQuota }) {
  let boundChat;
  const planFor = (action, state) => savedPromptPlan(action, state, process.env, Boolean(runCodexPrompt), Boolean(runCursorPrompt));
  const supports = (action, state) => action.task.kind === 'reminder' || Boolean(planFor(action, state));
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

  async function prepareCodexQuota(action, ts, isStopped) {
    if (!readCodexQuota || isStopped() || (await loadState()).state.extAuthBypass !== 'codex') return;
    if (await readReminderBreakerRefusal(action.id, ts)) return;
    const probe = await withAutonomyPauseLock(async () => {
      const target = await destination(isStopped);
      if (target?.state.extAuthBypass === 'codex') return trackAutonomyTurn(process.env, { counted: false });
    });
    if (!probe) return;
    // Let STOP interrupt the read without reporting a model turn or holding a lock.
    const active = AbortSignal.any([probe.signal, signal]);
    let report;
    try { report = await readCodexQuota({ signal: active, now }); }
    catch { /* Unknown quota leaves the ordinary box and action budgets in charge. */ }
    return { report, active, release: probe.release };
  }

  async function withLocalState(isStopped, update) {
    let result;
    // Serialize short commits with the in-process engine/provider updates.
    await updateState(async state => {
      if (!isStopped() && isLocalReminderEngine(state.engine) && reminderOwnerChat(state, adminId)) result = await update(state);
      return NO_STATE_WRITE;
    });
    return result;
  }

  async function admit(action, slotAt, ts, boxRefusal, quotaRead, publish, isStopped) {
    const target = await destination(isStopped);
    if (!target) return;
    // The provider and owner's saved spend are sampled after journal I/O.
    return withLocalState(isStopped, async state => {
      if (!reminderIsDue(action, slotAt, state.timezone || timezone)) return;
      const plan = action.task.kind === 'prompt' ? planFor(action, state) : undefined;
      if (action.task.kind === 'prompt' && !plan) return;
      const decisions = action.trigger.kind === 'once' ? undefined : await readReminderFrequencyDecisions();
      if (!reminderFrequencyAllows(action, decisions)) return;
      const breaker = await readReminderBreakerRefusal(action.id, ts);
      const codex = state.extAuthBypass === 'codex';
      const quotaCurrent = quotaRead?.report?.isCurrent;
      if (quotaRead && (!codex || quotaRead.active.aborted || (quotaCurrent && !await quotaCurrent()))) return;
      if (isStopped() || quotaRead?.active.aborted) return;
      const earlier = breaker ?? boxRefusal;
      if (!earlier && codex && readCodexQuota && !quotaRead) return;
      const quotaDetail = codex ? codexQuotaRefusal(quotaRead?.report?.quota, state, now(), target.reserveFraction) : undefined;
      const refusal = earlier ?? currentReminderRefusal(action, state, ts, target.reserveFraction, quotaDetail);
      const claimed = await publish(refusal);
      return { action: claimed, chat: target.chat, refusal, plan, quotaCurrent };
    });
  }

  async function promptOutcome(file, action, chat, plan, turn, quotaCurrent) {
    const active = AbortSignal.any([turn.signal, signal]);
    try {
      const result = await runSavedPrompt(action, plan, {
        runCodexPrompt,
        runCursorPrompt,
        signal: active, isCurrent: async () => await savedActionClaimIsCurrent(file, action) &&
          (!quotaCurrent || await quotaCurrent()),
      }).catch(() => ({
        status: 'deferred', detail: 'не удалось подготовить изолированный запуск',
      }));
      if (active.aborted) return { status: 'stopped', detail: 'ход прерван остановкой фоновых задач',
        fileCommitStarted: result.fileCommitStarted };
      return await deliverSavedPrompt(api, chat, result, active);
    } finally {
      turn.release();
    }
  }

  return async function dispatchReminders(isStopped) {
    const target = await destination(isStopped);
    if (!target) return;
    let snapshot = await savedActionSnapshot();
    const visited = await applyReminderFrequencyBrake(snapshot, {
      api, now, log, signal, supports, destination: () => destination(isStopped),
      withLocalState: update => withLocalState(isStopped, update), notify: sendText.bind(null, api),
    });
    if (visited) snapshot = await savedActionSnapshot();
    const { file, actions } = snapshot;
    // Old nwA selected every due row at one instant. Rz separately stamped
    // each attempt as it started, even if an earlier send crossed the minute.
    const slotAt = now();
    for (const snapshot of actions) {
      if (isStopped()) break;
      if (!reminderIsDue(snapshot, slotAt, target.timezone)) continue;
      if (!supports(snapshot, target.state)) {
        if (snapshot.enabled !== false && snapshot.task?.kind === 'prompt') {
          log('[msb/reminder] skip ' + snapshot.id
            + ' reason=no-plan provider=' + (target.state.extAuthBypass || 'claude'));
        }
        continue;
      }
      const ts = new Date(now()).toISOString();
      try {
        // Old shared journals can be slow. Read them before locking the local
        // pause, then recheck that both the action and route can still run.
        let boxRefusal = await readBoxReminderRefusal(ts);
        const quotaRead = boxRefusal ? undefined : await prepareCodexQuota(snapshot, ts, isStopped);
        let admitted;
        try {
          // Another bot can consume the shared budget while the native read is pending.
          if (quotaRead && !quotaRead.active.aborted) boxRefusal = await readBoxReminderRefusal(ts);
          admitted = await withAutonomyPauseLock(async () => {
            const claim = await claimSavedAction(file, snapshot, ts, {
              admit: (action, publish) => admit(action, slotAt, ts, boxRefusal, quotaRead, publish, isStopped),
            });
            if (claim?.plan && !claim.refusal) claim.turn = trackAutonomyTurn();
            return claim;
          });
        } finally {
          quotaRead?.release();
        }
        if (!admitted) continue;
        const { action, chat, refusal, turn, plan, quotaCurrent } = admitted;
        const result = refusal ?? (turn ? await promptOutcome(file, action, chat, plan, turn, quotaCurrent)
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
