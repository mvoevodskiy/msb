/**
 * Final owner response → [validation](../autonomy/reminder-protocol.mjs) →
 * [per-bot action](../autonomy/reminder-store.mjs). Worker: [bot](./bot.mjs).
 * Checks: [real worker + scheduler](../../tests/one-shot-reminder.test.mjs).
 */
import { loadState } from '../state.mjs';
import { readReminderPolicy, reminderOwnerChat } from '../autonomy/reminder-policy.mjs';
import { addReminder } from '../autonomy/reminder-store.mjs';
import { describeReminderConfirmation, parseReminderMarker } from '../autonomy/reminder-protocol.mjs';
import { limitMarker, outsideExamples, replaceAutonomyMarkers, scheduleMarker } from './autonomy-marker-text.mjs';

const disabled = 'Автономные задачи сейчас выключены.';
const unsupported = 'Фоновую задачу сейчас не ставлю: разовые напоминания на этом движке пока не подключены.';
const noCollector = 'Фоновую задачу сейчас не ставлю: на этом боксе некому вернуть результат, он до тебя не дойдёт.';
const invalid = 'Не понял задачу — повтори, пожалуйста.';
const failed = 'Не удалось поставить задачу.';

async function registrationPolicy(context) {
  const { state } = await loadState();
  const policy = await readReminderPolicy(state);
  if (!policy.enabled) return { error: disabled };
  if (!policy.local || policy.asleep || context.rail !== 'cc') return { error: unsupported };
  if (!reminderOwnerChat(state, context.ownerId)) return { error: noCollector };
  return { ...policy, timezone: state.timezone || context.timezone };
}

async function register(raw, context) {
  try {
    let policy = await registrationPolicy(context);
    if (policy.error) return policy;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return { error: invalid };
    }
    const parsed = parseReminderMarker(value, context);
    if (!parsed.action) return parsed;
    const saved = await addReminder(parsed.action, {
      signal: context.signal,
      async check() {
        policy = await registrationPolicy(context);
        return policy.error;
      },
    });
    if (!saved.action) return saved;
    return { text: describeReminderConfirmation(saved.action, context.now, policy.timezone, policy) };
  } catch {
    context.signal?.throwIfAborted();
    return { error: failed };
  }
}

export async function processReminderMarkers(text, context) {
  if (typeof text !== 'string' || !text.includes('[SCHEDULE_TASK]')) return text;
  const blocks = outsideExamples(text, scheduleMarker, [...text.matchAll(limitMarker)]);
  return replaceAutonomyMarkers(text, blocks, async block => {
    context.signal?.throwIfAborted();
    return context.ownerId && context.ok ? register(block[1], context) : { text: '(задача не обработана)' };
  });
}
