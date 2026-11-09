/**
 * Old xg/mg text for [conversational reads](../task-inspection-markers.mjs).
 * [Stored records and activity](../../autonomy/saved-task-inspection.mjs)
 * are read independently of [event and optional settings](./task-inspection-options.mjs).
 * [Telegram checks](../../../tests/saved-task-inspection.test.mjs).
 */
import { savedTaskSpent, validReminderTrigger } from '../../autonomy/reminder-schedule.mjs';
import { describeReminderScheduleWithNext, reminderDateClock } from '../../autonomy/reminder-time.mjs';
import { savedTaskTimezone } from '../../autonomy/saved-task-inspection.mjs';
import { legacyTimerOverlap } from '../../autonomy/reminder-registration-advice.mjs';
import { eventSchedule, taskInspectionOptions } from './task-inspection-options.mjs';

const kinds = {
  reminder: 'напоминание', prompt: 'сбор', draft: 'черновик', digest: 'дайджест', collect: 'сбор данных',
};
const outcomes = {
  ok: 'сработало', empty: 'сообщать было нечего', verify_flagged: 'результат не прошёл проверку',
  refusal: 'провайдер модели отказал', engine_error: 'ход не удался', empty_error: 'ход закончился без ответа',
  approval_blocked: 'не дали разрешение на команду', delivery_failed: 'результат не удалось доставить',
  stopped: 'остановил стоп-кран', blocked: 'не пустила квота или дневной предел',
};
const reasons = {
  consecutive_failures: 'предохранитель: провалы подряд', budget_cap: 'дневной предел расходов',
  kill_switch: 'стоп-кран', approval_required: 'ждёт разрешения',
  provider_block: 'провайдер отказал: деньги или лимит подписки',
  provider_quota: 'у провайдера почти не осталось — отступили заранее',
  frequency: 'слишком частая, ждёт решения владельца',
  migrated_to_oc: 'перенесена в OpenClaw: её запускает бот OpenClaw',
  left_on_migration: 'снята при переходе на OpenClaw: в боте OpenClaw её надо завести заново',
};
const nativePauseReasons = {
  frequency: 'срабатывает слишком часто, жду твоего решения', budget: 'дневной предел расходов',
  breaker: 'ходы подряд не удавались', owner: 'ты сам её остановил',
};

const label = (labels, key, fallback) => Object.hasOwn(labels, key) ? labels[key] : fallback;
const kind = action => label(kinds, action.task.kind, 'задача');
const note = value => value ? ' · ' + value : '';
const runClock = (target, now, timezone) => reminderDateClock(target, now, timezone, { shortDate: true });

function lastOutcome(action, success = 'сработала') {
  if (action.lastOutcome) return label(outcomes, action.lastOutcome, 'ход не состоялся');
  if (action.lastStatus === 'error') return 'ход не удался';
  return action.lastStatus === 'ok' ? success : 'результат ещё не записан';
}

function runStatus(action, now, timezone) {
  const status = [];
  if (action.disabledReason && !['owner', 'spent_once'].includes(action.disabledReason)) {
    status.push('сейчас снята — ' + label(reasons, action.disabledReason, action.disabledReason));
  }
  const last = Date.parse(action.lastRunAt);
  if (Number.isFinite(last)) {
    const { today, date, clock } = runClock(last, now, timezone);
    status.push('последний раз ' + (today ? 'сегодня' : date) + ' в ' + clock + ': ' + lastOutcome(action));
  }
  return status.join(' · ');
}

function schedule(action, now, timezone) {
  const { trigger } = action;
  if (trigger?.kind === 'when') return eventSchedule(action, now, timezone);
  if (!validReminderTrigger(trigger)) return trigger?.kind === 'heartbeat' ? 'heartbeat' : 'расписание не удалось прочитать';
  if (trigger.kind === 'once' && savedTaskSpent(action) && Date.parse(trigger.at) <= now) {
    const at = Date.parse(trigger.at);
    const last = Date.parse(action.lastRunAt);
    const { today, date, clock, zone } = runClock(at, now, timezone);
    const result = last >= at - 60_000 ? lastOutcome(action, 'сработало') : 'ход не состоялся';
    return 'срок прошёл (' + (today ? 'сегодня' : date) + ' в ' + clock + ', ' + zone + ') — ' +
      result + ', больше не сработает';
  }
  return describeReminderScheduleWithNext(trigger, now, timezone, action.lastRunAt);
}

function taskRow(action, now, timezone) {
  return action.name + ' (' + kind(action) + ') — ' + schedule(action, now, timezone);
}

function nativePause(job, policy) {
  if (job?.enabled !== false || job.pausedBy === 'stop' && policy.stopped) return '';
  const reason = label(nativePauseReasons, job.pausedBy, '');
  return 'сейчас придержана' + (reason ? ' — ' + reason : '');
}

function listRow({ action, timezone, job, available, frequencyHeld, silentAt }, now, policy) {
  let activity = nativePause(job, policy);
  if (!activity && frequencyHeld && action.disabledReason !== 'frequency') {
    activity = 'сейчас придержана — срабатывает слишком часто, жду твоего решения';
  }
  if (!activity && !available && !action.disabledReason) activity = 'запуск на текущем движке пока недоступен';
  const clock = silentAt === undefined ? undefined : runClock(silentAt, now, timezone);
  return '• ' + taskRow(action, now, timezone) + note(activity) +
    note(clock ? 'молчит с ' + (clock.today ? clock.clock : clock.date) : '') + note(runStatus(action, now, timezone));
}

const weekdays = ['воскресеньям', 'понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам'];
const clockPart = (value, max) => String(Math.max(0, Math.min(max, Number(value) || 0))).padStart(2, '0');

function timerSchedule(timer) {
  if (timer.type === 'once') return 'один раз' + (timer.at ? ', ' + timer.at : '');
  const time = ' в ' + clockPart(timer.hour, 23) + ':' + clockPart(timer.minute, 59);
  if (timer.type !== 'weekly') return 'каждый день' + time;
  const days = Array.isArray(timer.weekdays)
    ? timer.weekdays.map(day => weekdays[day === 7 ? 0 : day]).filter(day => typeof day === 'string') : [];
  return (days.length ? 'по ' + days.join(', ') : 'раз в неделю') + time;
}

function timerSections(timers, entries) {
  const enabled = timers.filter(timer => timer.enabled !== false);
  if (!enabled.length) return [];
  const rows = enabled.map(timer => '• ' + timer.name + ' — ' + timerSchedule(timer));
  const duplicates = [...new Set(enabled.filter(timer => entries.some(({ action }) => legacyTimerOverlap(timer, action)))
    .map(timer => timer.name))];
  const sections = ['Ещё у тебя есть таймеры с прошлой настройки (' + rows.length +
    '). Они работают отдельно от задач выше:\n' + rows.join('\n')];
  if (duplicates.length) sections.push('🔴 Похоже, часть из них делает то же, что задачи выше: ' +
    duplicates.join(', ') + '. Тогда отчёт придёт дважды. Скажи, если убрать старый — я подготовлю.');
  return sections;
}

function pauseLine(policy, nativeMayStillRun) {
  if (!policy.stopped) return '';
  if (policy.fleetStopped) return '⏸ Действует общая пауза сервера для фоновых задач.';
  if (nativeMayStillRun) return '⏸ Локальные фоновые задачи сейчас на паузе. Задачи OpenClaw могут продолжать работать отдельно.';
  return '⏸ Фоновые задачи сейчас на паузе и не сработают. Чтобы снять её, скажи «верни фоновые задачи в работу».';
}

export function describeSavedTaskList({ entries, spent, ownerPaused, timers, now, timezone, policy, jobs, nativeMayStillRun }) {
  const sections = [];
  const active = entries.length ? 'Фоновые задачи, срабатывают сами по расписанию (' + entries.length + '):\n' +
    entries.map(entry => listRow(entry, now, policy)).join('\n') :
    'Фоновых задач нет — ничего не срабатывает само по расписанию.';
  const pause = pauseLine(policy, nativeMayStillRun);
  sections.push(pause ? pause + '\n' + active : active);
  const row = action => taskRow(action, now, savedTaskTimezone(action, timezone,
    jobs && Object.hasOwn(jobs, action.id) ? jobs[action.id] : undefined));
  if (spent.length) sections.push('Уже не сработают (' + spent.length + '):\n' +
    spent.map(action => '✖ ' + row(action)).join('\n'));
  if (ownerPaused.length) sections.push('На личной паузе (' + ownerPaused.length + '), сработают, когда вернёшь в работу:\n' +
    ownerPaused.map(action => '⏸ ' + row(action)).join('\n'));
  return sections.concat(timerSections(timers, entries)).join('\n\n');
}

export function describeSavedTask(action, now, timezone, { native }) {
  const paused = !action.enabled && action.disabledReason === 'owner' ? ' · сейчас на личной паузе' : '';
  const eventUnavailable = action.trigger?.kind === 'when' && !native
    ? ' · проверка по событию пока не подключена к локальному движку' : '';
  const intro = '«' + action.name + '» — ' + kind(action) + '.\nРасписание: ' +
    schedule(action, now, timezone) + paused + eventUnavailable;
  const body = action.task.kind === 'reminder' ? action.task.text :
    ['prompt', 'draft'].includes(action.task.kind) ? action.task.prompt : undefined;
  const fragments = [{ text: intro + '\n\n' }];
  if (typeof body === 'string') {
    fragments.push({ text: 'Текст задачи, дословно:\n' },
      { text: body.split('\n').map(line => '│ ' + line).join('\n'), verbatim: true });
  } else {
    fragments.push({ text: 'Свободного текста у этой задачи нет: она собирает материал сама, по своим правилам.' });
  }
  const options = taskInspectionOptions(action, now, timezone);
  if (options.length) fragments.push({ text: '\n\nНастроено:\n' + options.map(value => '• ' + value).join('\n') });
  const last = runStatus(action, now, timezone);
  fragments.push({ text: '\n\n' + (last ? last[0].toUpperCase() + last.slice(1) + '.' : 'Ещё ни разу не срабатывала.') });
  return { fragments };
}
