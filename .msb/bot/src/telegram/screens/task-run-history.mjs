/**
 * Old ma/Vw report for [TASK_RUNS](../task-inspection-markers.mjs).
 * [Journal projection](../../autonomy/saved-task-runs.mjs) owns selection, windows
 * and aggregates. The caller escapes stored labels and event text before final delivery.
 */
import { taskRunReadLimit, taskRunWindowDays } from '../../autonomy/saved-task-runs.mjs';
import { reminderDateClock } from '../../autonomy/reminder-time.mjs';
import { savedTaskLabel } from './task-inspection.mjs';

const summaryLabels = {
  ok: 'отработали и прислали результат',
  quiet: 'промолчали, сообщать было нечего',
  truncated: 'оборвались, не доделав работу',
  error: 'закончились ошибкой',
  limited: 'придержаны пределом',
  stopped: 'сняты стопом',
  other: 'прочее',
};
const runLabels = {
  truncated: 'оборвался, работа не доделана', quiet: 'сообщать было нечего',
  ok: 'отработал', skipped: 'пропущен', blocked: 'придержан пределом',
  stopped: 'снят стопом', deferred: 'отложен', error: 'ошибка', unknown: 'исход неизвестен',
};
const groupLimit = 8;
const plural = new Intl.PluralRules('ru');
const word = (count, one, few, many) => ({ one, few, many })[plural.select(count)];
const runCount = count => count + ' ' + word(count, 'прогон', 'прогона', 'прогонов');

function runTime(at, now, timezone) {
  if (!Number.isFinite(at)) return 'время неизвестно';
  const { today, date, clock } = reminderDateClock(at, now, timezone, { shortDate: true });
  return (today ? 'сегодня' : date) + ' в ' + clock;
}

function describeGroups(groups, actions, formatTime) {
  const lines = groups.slice(0, groupLimit).map(({ count, latest }) => {
    const { actionId, name, eventId } = latest.row;
    const action = actions.find(row => row?.id === actionId && typeof row.name === 'string');
    const label = action ? savedTaskLabel(action) : typeof name === 'string' ? name : actionId;
    const event = eventId && (typeof eventId === 'string' || Number.isFinite(eventId)) ? ', событие ' + eventId : '';
    return '• ' + label + ' — ' + runCount(count) + ', последний ' +
      formatTime(latest) + ', ' + runLabels[latest.outcome] + event;
  });
  const sections = ['По задачам:\n' + lines.join('\n')];
  const extra = groups.length - lines.length;
  if (extra) sections.push('И ещё ' + extra + ' ' + word(extra, 'задача', 'задачи', 'задач') + ' с прогонами за это окно.');
  return sections;
}

function describeExpense({ paid, paidRuns, metered, inputRuns, tokensIn, inputIncomplete }, recentCount) {
  const expenses = [];
  if (paid > 0) expenses.push('оплачено $' + paid.toFixed(2) + ' за ' + runCount(paidRuns));
  if (metered > 0) expenses.push('по счётчику модели ходы съели $' + metered.toFixed(2));
  if (inputIncomplete) {
    expenses.push(tokensIn > 0 ? 'прочитано не менее ' + tokensIn + ' токенов, учёт неполный' :
      'учёт токенов неполный, число токенов неизвестно');
  } else if (inputRuns) {
    const tokens = tokensIn >= 1000 ? (tokensIn / 1000).toFixed(1) + 'k' : String(tokensIn);
    expenses.push('к модели обращались на ' + inputRuns + ' ' + word(inputRuns, 'ходу', 'ходах', 'ходах') +
      ' из ' + recentCount + ', прочитано ' + tokens + ' токенов');
  }
  return expenses.length ? 'Расход: ' + expenses.join(' · ') + '.' :
    'Сколько это стоило, сказать не могу: цену этих ходов мы не знаем.';
}

export function describeSavedTaskRunHistory({ runs, actionId, records, recentCount, dayCount, groups, totals, truncated },
  now, timezone) {
  if (!runs.length) return actionId ? 'По этой задаче прогонов в журнале нет. Либо её час ещё не наступал, либо она появилась недавно.' :
    'Прогонов в журнале пока нет. Это не поломка: если задачи стоят, но их час ещё не наступал, записывать нечего.';
  const formatTime = entry => runTime(entry.at, now, timezone);
  const latest = runs[0];
  const subject = actionId ? 'Эта задача' : 'Фоновая работа';
  const period = 'за ' + taskRunWindowDays + ' суток';
  const sections = [recentCount ? subject + ' ' + period + ': ' + runCount(recentCount) + ', из них за сутки ' + dayCount + '.' :
    subject + ': ' + period + ' прогонов не было. Всего в журнале ' + runCount(runs.length) + ', последний ' + formatTime(latest) + '.'];
  if (recentCount) sections.push(Object.entries(summaryLabels).filter(([key]) => totals.counts.has(key))
    .map(([key, label]) => '• ' + label + ': ' + totals.counts.get(key)).join('\n'));
  if (groups.length) sections.push(...describeGroups(groups, records, formatTime));
  if (actionId) {
    sections.push('Последний ход: ' + formatTime(latest) + ', ' + runLabels[latest.outcome] + '.');
    if (typeof latest.row.event === 'string' && latest.row.event) sections.push('Событие: ' + latest.row.event);
  }
  if (recentCount) sections.push(describeExpense(totals, recentCount));
  sections.push(truncated ? 'Показаны последние ' + taskRunReadLimit +
    ' записей журнала — если работа шла дольше, начало сюда не попало.' :
    'Журнал ведётся с ' + formatTime(runs.at(-1)) + ', раньше этого срока данных нет.');
  return sections.join('\n\n');
}
