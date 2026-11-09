/**
 * Final owner response → [validation](../autonomy/reminder-protocol.mjs) →
 * [per-bot action](../autonomy/reminder-store.mjs) → [advice](../autonomy/reminder-registration-advice.mjs).
 * Worker: [bot](./bot.mjs). [One-off checks](../../tests/one-shot-reminder.test.mjs)
 * and [recurring checks](../../tests/recurring-reminder-registration.test.mjs),
 * [saved collection checks](../../tests/saved-prompt-registration.test.mjs).
 */
import { loadState, NO_STATE_WRITE, updateState } from '../state.mjs';
import { readReminderPolicy, reminderOwnerChat } from '../autonomy/reminder-policy.mjs';
import { addSavedAction } from '../autonomy/reminder-store.mjs';
import { savedPromptPlan } from '../autonomy/prompt-policy.mjs';
import { promptRegistrationPermissions, promptRegistrationReady } from '../autonomy/prompt-registration.mjs';
import { readAutonomyPause } from '../autonomy/owner-pause.mjs';
import { reminderRegistrationAdvice } from '../autonomy/reminder-registration-advice.mjs';
import { describeReminderConfirmation, parseReminderMarker } from '../autonomy/reminder-protocol.mjs';
import { limitMarker, outsideExamples, replaceAutonomyMarkers, scheduleMarker, taskControlMarker } from './autonomy-marker-text.mjs';

const disabled = 'Автономные задачи сейчас выключены.';
const unsupported = 'Фоновую задачу сейчас не ставлю: задачи по времени на этом движке пока не подключены.';
const unavailableCollection = 'Фоновую задачу сейчас не ставлю: сбор на выбранном движке недоступен.';
const noCollector = 'Фоновую задачу сейчас не ставлю: на этом боксе некому вернуть результат, он до тебя не дойдёт.';
const invalid = 'Не понял задачу — повтори, пожалуйста.';
const failed = 'Не удалось поставить задачу.';

async function registrationPolicy(context, state) {
  const policy = await readReminderPolicy(state);
  if (!policy.enabled) return { error: disabled };
  if (!policy.local || policy.asleep || context.rail !== 'cc') return { error: unsupported };
  if (!reminderOwnerChat(state, context.ownerId)) return { error: noCollector };
  return { ...policy, timezone: state.timezone || context.timezone };
}

async function publishScheduledAction(context, action, publish) {
  let result;
  // The action file lock is already held. Serialize the final route check and
  // publication with ordinary owner state changes without writing state.json.
  await updateState(async state => {
    const policy = await registrationPolicy(context, state);
    if (policy.error) {
      result = policy;
      return NO_STATE_WRITE;
    }
    const collection = action.task.kind === 'prompt';
    const plan = collection ? savedPromptPlan(action, state, process.env, context.codexAvailable) : undefined;
    const ready = !collection || await promptRegistrationReady(plan?.provider, context.checkSavedCodex);
    result = ready ? { ...await publish(), timezone: policy.timezone, provider: plan?.provider }
      : { error: unavailableCollection };
    return NO_STATE_WRITE;
  });
  return result;
}

async function register(raw, context) {
  try {
    const { state } = await loadState();
    const policy = await registrationPolicy(context, state);
    if (policy.error) return policy;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return { error: invalid };
    }
    const parsed = parseReminderMarker(value, { ...context, timezone: policy.timezone });
    if (!parsed.action) return parsed;
    const saved = await addSavedAction(parsed.action, {
      signal: context.signal,
      commit: publish => publishScheduledAction(context, parsed.action, publish),
    });
    if (!saved.action) return saved;
    const [advice, permissions] = await Promise.all([
      reminderRegistrationAdvice(saved.action, saved.previous, context.now, saved.timezone).catch(() => ''),
      promptRegistrationPermissions(saved.action, saved.provider),
    ]);
    const pause = await readAutonomyPause().catch(() => ({ unknown: true }));
    return { text: describeReminderConfirmation(saved.action, context.now, saved.timezone, pause, { advice, permissions }) };
  } catch {
    context.signal?.throwIfAborted();
    return { error: failed };
  }
}

export async function processReminderMarkers(text, context) {
  if (typeof text !== 'string' || !text.includes('[SCHEDULE_TASK]')) return text;
  const blocks = outsideExamples(text, scheduleMarker, [...text.matchAll(limitMarker), ...text.matchAll(taskControlMarker)]);
  return replaceAutonomyMarkers(text, blocks, async block => {
    context.signal?.throwIfAborted();
    return context.ownerId && context.ok ? register(block[1], context) : { text: '(задача не обработана)' };
  });
}
