/**
 * Old local STOP_ALL / RESUME_ALL from a successful owner turn. [Worker](./bot.mjs)
 * passes the captured route; [owner pause](../autonomy/owner-pause.mjs) is the writer.
 * [Legacy confirmation](./pause-confirmation.mjs) is a separate owner action.
 * [Ingress and dispatch checks](../../tests/autonomy-pause.test.mjs).
 */
import { setOwnerPause, readAutonomyPause } from '../autonomy/owner-pause.mjs';
import { listLegacyTimers } from '../autonomy/legacy-timers.mjs';
import { isLocalReminderEngine, readReminderPolicy } from '../autonomy/reminder-policy.mjs';
import { savedActionSnapshot, readNativeJobMap } from '../autonomy/reminder-store.mjs';
import { describeReminderSchedule, describeReminderTime } from '../autonomy/reminder-time.mjs';
import { reminderIsActive } from '../autonomy/reminder-frequency.mjs';
import { readReminderFrequencyDecisions } from '../autonomy/frequency-decisions.mjs';
import { savedPromptPlan } from '../autonomy/prompt-policy.mjs';
import { listTasks } from '../autonomy/store.mjs';
import { loadState } from '../state.mjs';
import { limitMarker, outsideExamples, replaceAutonomyMarkers, scheduleMarker, taskCancelMarker, taskControlMarker, taskInspectionMarker } from './autonomy-marker-text.mjs';
import { askToPauseLegacyTimers } from './pause-confirmation.mjs';

const control = /\[(STOP_ALL|RESUME_ALL)\]/g;
const stopConflict = '🔴 В одном сообщении оказались и «останови», и «продолжай». Выполнил только «останови» — снимать стоп тем же сообщением, которым его ставят, я не буду. Скажи «продолжай» отдельно, когда захочешь снять.';
const resumeConflict = '🔴 В одном сообщении оказались и «продолжай», и «останови». Выполнил только «продолжай». Скажи «останови» отдельно, если хотел остановить.';

const unavailableEngine = 'Управление фоновой паузой на этом движке пока не подключено.';

async function checkPolicy(context) {
  const { state } = await loadState();
  const policy = await readReminderPolicy(state);
  if (!policy.enabled) return 'Автономные задачи сейчас выключены.';
  if (!policy.local || policy.asleep || context.rail !== 'cc') {
    return unavailableEngine;
  }
}

async function localActiveTasks(now, codexAvailable) {
  const [intervals, saved, decisions, { state }] = await Promise.all([
    listTasks().catch(() => []),
    savedActionSnapshot().catch(() => ({ actions: [] })),
    readReminderFrequencyDecisions(), loadState(),
  ]);
  return [
    ...saved.actions.filter(action => reminderIsActive(action, decisions) &&
      (action.task.kind === 'reminder' || savedPromptPlan(action, state, process.env, codexAvailable)))
      .map(action => ({ name: action.name, trigger: action.trigger })),
    ...intervals.filter(task => task && task.enabled !== false).map(task => {
      const next = new Date(task.nextAt ?? now);
      return {
        name: task.title || task.id || 'задача',
        at: Number.isFinite(next.getTime()) ? next.toISOString() : new Date(now).toISOString(),
      };
    }),
  ];
}

async function describeStop(result, tasks, ctx, context) {
  const [timers, native] = await Promise.all([
    listLegacyTimers(),
    readNativeJobMap().then(jobs => Object.values(jobs).filter(job => job?.jobId && !job.pausedBy).length, () => null),
  ]);
  const count = timers.filter(timer => timer.enabled !== false).length;
  const summary = result.aborted ? 'оборвано идущих ходов: ' + result.aborted + ', ' : '';
  const lines = ['⛔ Автономка остановлена. ' + summary + 'снято с расписания задач: 0.'];
  if (native === null) lines.push('🔴 Расписание OpenClaw не удалось проверить.');
  else if (native) lines.push('🔴 Остановка неполная: в профиле остались активные записи OpenClaw (' + native + ').');
  else lines.push('Новые прогоны не начнутся, пока вы не включите обратно.');
  lines.push(tasks.length
    ? 'Задач сохранено: ' + tasks.length + ', они никуда не делись. Чтобы вернуть их в работу, скажи «верни задачи в работу» — «продолжай» я тоже пойму.'
    : 'Чтобы снять паузу, скажи «верни задачи в работу».');
  if (count) {
    await askToPauseLegacyTimers(ctx, count, result.generation, context);
    lines.push('', '🔴 Учти: ' + count + (count === 1 ? ' таймер' : ' таймера') +
      ' с прошлой настройки этим не остановлены — они на другом механизме. Скажи, если их тоже гасить.');
  }
  return lines.join('\n');
}

async function describeResume(result, tasks, { now, timezone }) {
  const pause = await readAutonomyPause().catch(() => null);
  const timerNote = result.timerResumeFailed
    ? '\n⚠ Таймеры поднять не удалось — включи их в настройках, раздел Таймеры.'
    : result.resumedTimers ? '\nТаймеры, остановленные вместе со всеми, снова работают (' + result.resumedTimers + ').' : '';
  if (!pause) return 'Снял паузу этого бота. Общую паузу сервера не удалось проверить.' + timerNote;
  if (pause.fleetStopped) return 'Снял паузу этого бота. Общая пауза сервера остаётся.' + timerNote;
  if (pause.ownerStopped) return 'Пауза этого бота снова включена.' + timerNote;
  if (!tasks.length) return 'Снял стоп. Активных задач сейчас нет.' + timerNote;
  const { state } = await loadState();
  const zone = state.timezone || timezone;
  const names = tasks.map(task => '• ' + task.name + ' — ' + (task.trigger
    ? describeReminderSchedule(task.trigger, now, zone) : describeReminderTime(task.at, now, zone)));
  return 'Снял паузу, задачи снова в работе (' + tasks.length + '):\n' + names.join('\n') + timerNote;
}

async function changePause(command, context, ctx) {
  const stop = command === 'STOP_ALL';
  let result;
  try {
    const unavailable = await checkPolicy(context);
    if (unavailable) return { error: unavailable };
    result = await setOwnerPause(stop, {
      now: context.now, signal: context.signal, check: () => checkPolicy(context),
      checkEngine: state => isLocalReminderEngine(state.engine) ? undefined : unavailableEngine,
    });
  } catch {
    context.signal?.throwIfAborted();
    return { error: stop ? 'Не удалось остановить фоновые задачи.' : 'Не удалось снять стоп.' };
  }
  if (result.error) return result;
  const tasks = await localActiveTasks(context.now, context.codexAvailable);
  const text = stop ? await describeStop(result, tasks, ctx, context) : await describeResume(result, tasks, context);
  return { text };
}

export async function processPauseMarkers(text, context, ctx) {
  if (typeof text !== 'string' || !(text.includes('[STOP_ALL]') || text.includes('[RESUME_ALL]'))) return text;
  const protectedRanges = [...text.matchAll(scheduleMarker), ...text.matchAll(limitMarker), ...text.matchAll(taskControlMarker), ...text.matchAll(taskCancelMarker), ...text.matchAll(taskInspectionMarker)];
  const blocks = outsideExamples(text, control, protectedRanges).filter(block => {
    const suffix = text.slice(block.index + block[0].length).split('\n', 1)[0];
    return !suffix.replace(control, '').trim();
  });
  let first;
  return replaceAutonomyMarkers(text, blocks, async block => {
    context.signal?.throwIfAborted();
    if (!context.ownerId || !context.ok) return { text: '(задача не обработана)' };
    if (first === undefined) {
      first = await changePause(block[1], context, ctx);
      return first;
    }
    if (first.error || block[1] === blocks[0][1]) return { text: '' };
    return { text: blocks[0][1] === 'STOP_ALL' ? stopConflict : resumeConflict };
  });
}
