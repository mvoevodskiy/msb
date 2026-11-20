/**
 * Final owner reply → [named action update](../autonomy/reminder-store.mjs) → old acknowledgement.
 * [Selector and state rules](../autonomy/saved-action-control.mjs).
 * [Global STOP](./pause-markers.mjs) and legacy timers keep their own routes.
 * [Ingress and scheduler checks](../../tests/saved-task-control.test.mjs).
 */
import { loadState, NO_STATE_WRITE, updateState } from '../state.mjs';
import { readAutonomyPause } from '../autonomy/owner-pause.mjs';
import { readReminderPolicy } from '../autonomy/reminder-policy.mjs';
import { setOwnedNativeReminderEnabled } from '../autonomy/openclaw-reminder-control.mjs';
import { setNamedSavedActionEnabled } from '../autonomy/reminder-store.mjs';
import { describeReminderScheduleWithNext } from '../autonomy/reminder-time.mjs';
import { readReminderFrequencyDecisions } from '../autonomy/frequency-decisions.mjs';
import { reminderFrequencyAllows } from '../autonomy/reminder-frequency.mjs';
import { savedPromptPlan } from '../autonomy/prompt-policy.mjs';
import { promptRegistrationReady } from '../autonomy/prompt-registration.mjs';
import { limitMarker, outsideExamples, replaceAutonomyMarkers, scheduleMarker, taskCancelMarker, taskControlMarker, taskInspectionMarker } from './autonomy-marker-text.mjs';

// A direct assertion may contain a quoted task name. A quoted or explained
// assertion does not start with the action verb and remains ordinary text.
const claim = /^\s*(?:[✅✔]\uFE0F?\s*)?(?:выключил[аи]?|включил[аи]?|вернул[аи]?|поставил[аи]?|готово|остановил[аи]?|возобновил[аи]?)(?=$|[\s.,!])/iu;

async function routeError(state, context) {
  const policy = await readReminderPolicy(state);
  if (!policy.enabled) return 'Автономные задачи сейчас выключены.';
  if (!policy.local || policy.asleep || context.rail !== 'cc') return 'Управление задачами на этом движке пока не подключено.';
}

async function commitControl(context, publish) {
  let result;
  // The per-profile action lock is already held. Use the same state queue
  // as provider switches and scheduler admission, with no state rewrite.
  await updateState(async state => {
    const error = await routeError(state, context);
    result = error ? { error } : { ...await publish(), state };
    return NO_STATE_WRITE;
  });
  return result;
}

function globalPauseNote(pause) {
  if (!pause) return '🔴 Состояние общей паузы не удалось прочитать.';
  if (pause.ownerStopped && pause.fleetStopped) return '🔴 Пауза этого бота и общая пауза сервера остаются.';
  if (pause.fleetStopped) return '🔴 Общая пауза сервера остаётся.';
  if (pause.ownerStopped) return '🔴 Пауза этого бота остаётся.';
  return '';
}

async function resumeNote(action, state, context) {
  if (action.budget?.killSwitch) return '🔴 Запуск выключен в настройках этой задачи.';
  if (!reminderFrequencyAllows(action, await readReminderFrequencyDecisions())) {
    return '📡 Пока действует ограничение частоты.';
  }
  if (action.task.kind === 'prompt') {
    const plan = savedPromptPlan(action, state, process.env, context.codexAvailable, context.cursorAvailable);
    if (!await promptRegistrationReady(plan?.provider, context.checkSavedCodex, process.env, context.checkSavedCursor)) {
      return '🔴 Запуск этой задачи на выбранном движке пока недоступен.';
    }
  }
  return '';
}

async function describeControl({ action, changed, state, nativeUnconfirmed, nativeHeld }, enabled, context) {
  const name = '«' + action.name + '»';
  const global = globalPauseNote(await readAutonomyPause().catch(() => null));
  const warning = nativeUnconfirmed
    ? '\n⚠ Не удалось ' + (enabled ? 'вернуть в расписание движка.' : 'снять с расписания движка — если сработает вопреки паузе, скажи мне.')
    : '';
  if (!enabled) {
    const intro = changed ? '⏸ ' + name + ' на паузе.' : name + ' и так на паузе.';
    const others = changed && !global ? ' Остальные задачи работают.' : '';
    return intro + others + ' Скажи «верни в работу ' + action.name + '», когда понадобится.' + (global ? '\n' + global : '') + warning;
  }
  const note = global || await resumeNote(action, state, context) ||
    (nativeHeld && !nativeUnconfirmed ? '🔴 Запуск этой задачи на выбранном движке пока недоступен.' : '');
  const confirmed = !note && !nativeUnconfirmed;
  if (!changed) return name + (confirmed ? ' и так в работе.' : ' уже включена.') + (note ? ' ' + note : '') + warning;
  const when = describeReminderScheduleWithNext(action.trigger, context.now, state.timezone || context.timezone, action.lastRunAt);
  return '▶ ' + name + (confirmed ? ' снова в работе' : ' включена') + ' — ' + when + '.' +
    (note ? '\n' + note : '') + warning;
}

async function changeControl(query, enabled, context) {
  let result;
  try {
    const { state } = await loadState();
    if (state.engine === 'oc' && context.rail === 'oc') {
      if (!(await readReminderPolicy(state)).enabled) return { error: 'Автономные задачи сейчас выключены.' };
      result = await setOwnedNativeReminderEnabled(query, enabled, context);
    } else {
      const error = await routeError(state, context);
      if (error) return { error };
      result = await setNamedSavedActionEnabled(query, enabled, {
        signal: context.signal, commit: publish => commitControl(context, publish),
      });
    }
  } catch {
    context.signal?.throwIfAborted();
    return { error: enabled ? 'Не удалось вернуть в работу.' : 'Не удалось поставить на паузу.' };
  }
  if (result.error) return result;
  return { text: await describeControl(result, enabled, context) };
}

export async function processTaskControlMarkers(text, context) {
  if (typeof text !== 'string' || !(text.includes('[PAUSE_TASK:') || text.includes('[RESUME_TASK:'))) return text;
  const protectedRanges = [...text.matchAll(scheduleMarker), ...text.matchAll(limitMarker), ...text.matchAll(taskCancelMarker), ...text.matchAll(taskInspectionMarker)];
  const blocks = outsideExamples(text, taskControlMarker, protectedRanges);
  const pauses = blocks.filter(block => block[1] === 'PAUSE_TASK');
  const resumes = blocks.filter(block => block[1] === 'RESUME_TASK');
  const results = new Map();
  // The old detector applied pauses before resumes and replaced each marker
  // in its original position in the reply.
  for (const block of [...pauses, ...resumes]) {
    context.signal?.throwIfAborted();
    const result = context.ownerId && context.ok
      ? await changeControl(block[2], block[1] === 'RESUME_TASK', context)
      : { text: '(задача не обработана)' };
    results.set(block, result);
  }
  return replaceAutonomyMarkers(text, blocks, block => results.get(block), {
    claim, correctBeforeEach: true, quoteGuard: /\x60/u,
  });
}
