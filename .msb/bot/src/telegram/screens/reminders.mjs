/**
 * Existing autonomy task list/card presentation for ordinary once/reminder.
 * [List](./autonomy.mjs) and [callbacks](../routes/autonomy.mjs) use the
 * [scoped actions store](../../autonomy/reminder-store.mjs); no native jobs here.
 */
import { InlineKeyboard } from 'grammy';
import { loadState } from '../../state.mjs';
import { isLocalReminderEngine, readReminderPolicy } from '../../autonomy/reminder-policy.mjs';
import { reminderSnapshot } from '../../autonomy/reminder-store.mjs';
import { describeReminderTime } from '../../autonomy/reminder-time.mjs';
import { escapeHtml } from '../edit.mjs';
import { BLANK } from './shared.mjs';

export async function reminderViews(state) {
  state ??= (await loadState()).state;
  const view = { actions: [], stopped: false, timezone: state.timezone, now: Date.now() };
  if (!isLocalReminderEngine(state.engine)) return view;
  try {
    const [policy, { actions }] = await Promise.all([readReminderPolicy(state), reminderSnapshot()]);
    return { ...view, actions, stopped: policy.stopped };
  } catch {
    return { ...view, error: '⚠️ Не удалось прочитать разовые напоминания.' };
  }
}

function mark(action) {
  return action.lastRunAt ? '✖' : action.enabled ? '✔' : '⏸';
}

function when(action, view) {
  const label = describeReminderTime(action.trigger.at, view.now, view.timezone);
  return escapeHtml(action.lastRunAt ? label + ' — больше не сработает' : label);
}

function actionButton(keyboard, label, callback) {
  if (Buffer.byteLength(callback) <= 64) keyboard.text(label, callback).row();
}

export function reminderRows(view, keyboard) {
  return view.actions.filter(action => action.enabled || action.disabledReason === 'owner').map(action => {
    const status = mark(action);
    actionButton(keyboard, (status + ' ' + action.name).slice(0, 30).toWellFormed(), 'auto:task:' + action.id);
    return status + ' <b>' + escapeHtml(action.name) + '</b> (напоминание)\n     ' + when(action, view);
  });
}

export function reminderCard(action, view) {
  const keyboard = new InlineKeyboard();
  if (!action.lastRunAt) {
    actionButton(keyboard, action.enabled ? '⏸ Выключить' : '▶️ Включить', 'auto:task-toggle:' + action.id);
  }
  actionButton(keyboard, '🗑 Удалить', 'auto:task-delete:' + action.id);
  keyboard.text('« Назад', 'auto:tasks');
  const status = action.lastRunAt ? '✖ уже не сработает' : action.enabled ? '✔ работает' : '⏸ на паузе';
  const lines = ['📋 <b>' + escapeHtml(action.name) + '</b>', '', 'Вид: напоминание',
    'Статус: ' + status, 'Когда: ' + when(action, view)];
  if (view.stopped && action.enabled) lines.push('⏸ Всё на паузе.');
  lines.push('', 'Что делает: <i>' + escapeHtml(action.task.text.slice(0, 400).toWellFormed()) + '</i>', BLANK);
  return { text: lines.join('\n'), keyboard };
}
