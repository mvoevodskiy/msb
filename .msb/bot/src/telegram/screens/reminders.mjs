/**
 * Existing autonomy task list/card for saved reminders and prompt actions.
 * [List](./autonomy.mjs) and [callbacks](../routes/autonomy.mjs) use the
 * [scoped actions store](../../autonomy/reminder-store.mjs); no native jobs here.
 */
import { InlineKeyboard } from 'grammy';
import { readConfig } from '../../config.mjs';
import { loadState } from '../../state.mjs';
import { isLocalReminderEngine, readReminderPolicy } from '../../autonomy/reminder-policy.mjs';
import { savedActionSnapshot } from '../../autonomy/reminder-store.mjs';
import { savedPromptPlan } from '../../autonomy/prompt-policy.mjs';
import { savedPromptTeam } from '../../autonomy/prompt-team.mjs';
import { describeReminderSchedule } from '../../autonomy/reminder-time.mjs';
import { reminderIsActive } from '../../autonomy/reminder-frequency.mjs';
import { readReminderFrequencyDecisions } from '../../autonomy/frequency-decisions.mjs';
import { spentReminder } from '../../autonomy/reminder-schedule.mjs';
import { escapeHtml } from '../edit.mjs';
import { BLANK } from './shared.mjs';

export async function savedActionViews(state, codexAvailable = false, cursorAvailable = false) {
  state ??= (await loadState()).state;
  const view = { actions: [], state, codexAvailable, cursorAvailable, stopped: false, timezone: state.timezone || readConfig().timezone, now: Date.now() };
  if (!isLocalReminderEngine(state.engine)) return view;
  try {
    const [policy, { actions }, decisions] = await Promise.all([
      readReminderPolicy(state), savedActionSnapshot(), readReminderFrequencyDecisions(),
    ]);
    return { ...view, actions, decisions, stopped: policy.stopped };
  } catch {
    return { ...view, error: '⚠️ Не удалось прочитать задачи.' };
  }
}

const kind = action => action.task.kind === 'reminder' ? 'напоминание' : 'сбор';
const supported = (action, view) => action.task.kind === 'reminder'
  || Boolean(savedPromptPlan(action, view.state, process.env, view.codexAvailable, view.cursorAvailable));

export function savedActionIsActive(action, view) {
  return reminderIsActive(action, view.decisions) && supported(action, view);
}

function mark(action, view) {
  return spentReminder(action) ? '✖' : savedActionIsActive(action, view) ? '✔' : '⏸';
}

function when(action, view) {
  const label = describeReminderSchedule(action.trigger, view.now, view.timezone);
  return escapeHtml(spentReminder(action) ? label + ' — больше не сработает' : label);
}

function actionButton(keyboard, label, callback) {
  if (Buffer.byteLength(callback) <= 64) keyboard.text(label, callback).row();
}

export function savedActionRows(view, keyboard) {
  return view.actions.filter(action => action.enabled || action.disabledReason === 'owner').map(action => {
    const status = mark(action, view);
    actionButton(keyboard, (status + ' ' + action.name).slice(0, 30).toWellFormed(), 'auto:task:' + action.id);
    return status + ' <b>' + escapeHtml(action.name) + '</b> (' + kind(action) + ')\n     ' + when(action, view);
  });
}

export function savedActionCard(action, view) {
  const keyboard = new InlineKeyboard();
  if (!spentReminder(action)) {
    actionButton(keyboard, action.enabled ? '⏸ Выключить' : '▶️ Включить', 'auto:task-toggle:' + action.id);
  }
  actionButton(keyboard, '🗑 Удалить', 'auto:task-delete:' + action.id);
  keyboard.text('« Назад', 'auto:tasks');
  const status = spentReminder(action) ? '✖ уже не сработает'
    : action.enabled && !supported(action, view) ? '⏸ запуск пока недоступен'
    : savedActionIsActive(action, view) ? '✔ работает' : '⏸ на паузе';
  const lines = ['📋 <b>' + escapeHtml(action.name) + '</b>', '', 'Вид: ' + kind(action),
    'Статус: ' + status, 'Когда: ' + when(action, view)];
  if (view.stopped && action.enabled) lines.push('⏸ Всё на паузе.');
  const body = action.task.kind === 'reminder' ? action.task.text : action.task.prompt;
  lines.push('', 'Что делает: <i>' + escapeHtml(body.slice(0, 400).toWellFormed()) + '</i>');
  const team = savedPromptTeam(action);
  if (team.length) lines.push('Команда: ' + escapeHtml(team.map(role => role.name).join(', ')));
  lines.push(BLANK);
  return { text: lines.join('\n'), keyboard };
}
