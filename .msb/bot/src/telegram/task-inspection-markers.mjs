/**
 * Successful owner reply → LIST_TASKS, SHOW_TASK or [TASK_RUNS](../autonomy/saved-task-runs.mjs).
 * The list can offer a
 * [separate owner question](./spent-task-confirmation.mjs). [Bot worker](./bot.mjs)
 * supplies the captured rail; [selector](../autonomy/saved-action-control.mjs) and
 * [screen](./screens/task-inspection.mjs) use the existing per-bot records.
 * [Telegram checks](../../tests/saved-task-inspection.test.mjs).
 */
import { readReminderPolicy } from '../autonomy/reminder-policy.mjs';
import { readSavedActionRecords, readNativeJobMap, spentTaskCandidates } from '../autonomy/reminder-store.mjs';
import { selectSavedAction } from '../autonomy/saved-action-control.mjs';
import { readSavedTaskList, savedTaskIsNative, savedTaskTimezone } from '../autonomy/saved-task-inspection.mjs';
import { readSavedTaskRunHistory } from '../autonomy/saved-task-runs.mjs';
import { loadState } from '../state.mjs';
import { describeSavedTask, describeSavedTaskList } from './screens/task-inspection.mjs';
import { askToClearSpentTasks } from './spent-task-confirmation.mjs';
import { describeSavedTaskRunHistory } from './screens/task-run-history.mjs';
import { limitMarker, outsideExamples, replaceAutonomyMarkers, scheduleMarker,
  taskControlMarker, taskInspectionMarker } from './autonomy-marker-text.mjs';

const readableTask = action => typeof action?.id === 'string' && typeof action.name === 'string' &&
  typeof action.task?.kind === 'string';

async function inspect(block, context, ctx) {
  const command = block[1] ?? block[2];
  const list = command === 'LIST_TASKS';
  const runs = command === 'TASK_RUNS';
  try {
    const { state } = await loadState();
    const policy = await readReminderPolicy(state);
    if (!policy.enabled) return { text: 'Автономные задачи сейчас выключены.' };
    const query = block[3]?.trim() ?? '';
    const timezone = state.timezone || context.timezone || 'Europe/Moscow';
    if (runs) {
      const rails = ['cc', 'oc'];
      if (!rails.includes(context.rail) || !rails.includes(state.engine || 'cc')) {
        return { text: 'История прогонов на этом движке пока не подключена.' };
      }
      const history = await readSavedTaskRunHistory(query, context.now);
      return { text: history.error ?? describeSavedTaskRunHistory(history, context.now, timezone) };
    }
    if (!policy.local || policy.asleep || context.rail !== 'cc') {
      return { text: 'Просмотр задач на этом движке пока не подключён.' };
    }
    if (!list && !query) return { text: 'Уточни, какую задачу показать.' };
    const { file, records } = await readSavedActionRecords();
    context.signal?.throwIfAborted();
    if (list) {
      const view = await readSavedTaskList(records.filter(readableTask), state, policy, { ...context, timezone });
      const candidates = spentTaskCandidates(view.spent, view.jobs);
      if (candidates.length) {
        await askToClearSpentTasks(ctx, file, candidates, context).catch(() => context.signal?.throwIfAborted());
      }
      return { text: describeSavedTaskList(view) };
    }
    const { action, error } = selectSavedAction(records, query);
    if (error) return { text: error };
    if (!readableTask(action)) return { text: 'Не удалось прочитать сохранённую задачу.' };
    const jobs = action.trigger?.timezone || action.trigger?.kind === 'when'
      ? await readNativeJobMap().catch(() => null) : null;
    const job = jobs && Object.hasOwn(jobs, action.id) ? jobs[action.id] : undefined;
    return describeSavedTask(action, context.now, savedTaskTimezone(action, timezone, job),
      { native: savedTaskIsNative(action, job) });
  } catch {
    context.signal?.throwIfAborted();
    if (runs) return { text: 'Не удалось прочитать историю прогонов.' };
    return { text: list ? 'Не удалось получить список.' : 'Не удалось показать задачу.' };
  }
}

export async function processTaskInspectionMarkers(text, context, ctx) {
  if (typeof text !== 'string' ||
      !['[LIST_TASKS]', '[SHOW_TASK:', '[TASK_RUNS'].some(marker => text.includes(marker))) return text;
  const ranges = [...text.matchAll(scheduleMarker), ...text.matchAll(limitMarker), ...text.matchAll(taskControlMarker)];
  const blocks = outsideExamples(text, taskInspectionMarker, ranges);
  return replaceAutonomyMarkers(text, blocks, async block => {
    context.signal?.throwIfAborted();
    const result = context.ownerId && context.ok ? await inspect(block, context, ctx) : { text: '(задача не обработана)' };
    context.signal?.throwIfAborted();
    return result;
  });
}
