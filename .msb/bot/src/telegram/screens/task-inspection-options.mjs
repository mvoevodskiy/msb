/**
 * Stored settings and event description for [task details](./task-inspection.mjs).
 * Reading an event record never performs its check or its configured action.
 */
import { reminderDateClock } from '../../autonomy/reminder-time.mjs';
import { savedPromptTeam } from '../../autonomy/prompt-team.mjs';

const quantity = (value, one, many) => value + ' ' + (value % 10 === 1 && value % 100 !== 11 ? one : many);
const conditionKinds = {
  service: check => 'служба «' + check.unit + '»',
  process: check => 'процесс «' + check.pattern + '»',
  http: check => 'адрес ' + check.url,
  path: check => 'путь ' + check.path,
  shell: check => 'команда «' + String(check.command ?? '').slice(0, 60) + '»',
  inbox: check => 'входящая' + (check.dir ? ' ' + check.dir : ''),
};

function eventLabel(fire, kind) {
  if (fire === 'new') return 'пришло новое событие';
  if (fire === 'change') return kind === 'path' ? 'появилось или изменилось' : 'изменилось';
  if (fire === 'ok') return kind === 'http' ? 'снова отвечает' : 'поднялось';
  return kind === 'http' ? 'перестал отвечать' : kind === 'path' ? 'пропал' : 'упало';
}

function eventDescription(trigger) {
  const check = trigger.check;
  if (!check || !Object.hasOwn(conditionKinds, check.kind) || !Number.isFinite(trigger.everyMinutes)) return '';
  return conditionKinds[check.kind](check) + ' ' + eventLabel(trigger.fire, check.kind) +
    ', проверка каждые ' + trigger.everyMinutes + ' мин';
}

function checkedAt(value, now, timezone) {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return 'в неизвестное время';
  const { clock, zone } = reminderDateClock(millis, now, timezone);
  return clock + ' (' + zone + ')';
}

function pendingEvent(state, now, timezone) {
  const pending = state?.pendingFire;
  if (!pending) return '';
  return ', сработало ' + checkedAt(pending.since, now, timezone) + ', ход не поставлен, попытка ' +
    pending.attempts + ' из 3: ' + (pending.lastReason ?? '?');
}

export function eventSchedule(action, now, timezone) {
  const description = eventDescription(action.trigger);
  if (!description) return 'условие не удалось прочитать';
  const command = action.trigger.then?.command;
  return 'по событию: ' + description + (typeof command === 'string' && command ? ', настроенное действие: ' + command : '') +
    pendingEvent(action.conditionState, now, timezone);
}

function conditionDetails(action, now, timezone) {
  const description = eventDescription(action.trigger);
  if (!description) return '';
  const state = action.conditionState;
  const command = action.trigger.then?.command;
  const configured = description + (typeof command === 'string' ? ', действие: «' + command.slice(0, 80) + '»' : '');
  if (!state?.lastCheckedAt) return configured + ', ещё не проверялось';
  const fires = state.fires > 0 ? 'срабатываний ' + state.fires + ', последнее ' +
    checkedAt(state.lastFiredAt ?? state.lastCheckedAt, now, timezone) : 'срабатываний не было';
  return configured + ', проверено ' + checkedAt(state.lastCheckedAt, now, timezone) + ': ' +
    (state.lastReason ?? '?') + '. ' + fires + pendingEvent(state, now, timezone);
}

export function taskInspectionOptions(action, now, timezone) {
  const { task, output, budget } = action;
  const options = [];
  if (task.kind === 'reminder' && task.followUp) {
    const { everyMinutes, maxRepeats } = task.followUp;
    options.push('Дожим: повторит каждые ' + everyMinutes + ' мин, до ' +
      quantity(maxRepeats, 'повтора', 'повторов') + ', пока не отметишь «Готово».');
  }
  if (output?.emptyIsValidOutcome) {
    options.push('Молчание в норме: пустой ход — обычный рабочий день, пишет только когда есть что сказать.');
  }
  if (task.kind === 'prompt' && Array.isArray(task.freshness?.paths) && Number.isFinite(task.freshness.maxAgeHours)) {
    const { paths, maxAgeHours } = task.freshness;
    options.push('Свежесть источников: ' + paths.join(', ') + ' — данные не старше ' +
      quantity(maxAgeHours, 'часа', 'часов') + ', иначе честно скажет, что смотреть было не во что.');
  }
  if (Number.isFinite(budget?.maxRunSeconds) && budget.maxRunSeconds > 0) {
    options.push('Длительность хода: до ' + quantity(Math.round(budget.maxRunSeconds / 60), 'минуты', 'минут') + '.');
  }
  if (task.kind === 'prompt') {
    const team = savedPromptTeam(action);
    if (team.length) options.push('Команда: ' + team.map(row => row.name + ' (' + row.brief + ')').join('; ') + '.');
    if (action.run?.memory === 'continuous') {
      options.push('Память: помнит прошлые ходы, в конце каждого хода пишет «Сделано» и «Дальше».' +
        (action.handoff?.next ? ' Планировала дальше: ' + action.handoff.next : ''));
    }
  }
  if (action.trigger?.kind === 'when') {
    const condition = conditionDetails(action, now, timezone);
    if (condition) options.push('Условие: ' + condition + '.');
  }
  return options;
}
