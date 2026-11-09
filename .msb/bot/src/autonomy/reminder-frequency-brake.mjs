/**
 * Old He/tg frequency transitions before [due selection](./reminder-dispatch.mjs).
 * Compare and publish the same saved action under its [store](./reminder-store.mjs)
 * and the owner pause lock. [Decision card](../telegram/frequency-confirmation.mjs)
 * and notices are sent after the action lock is released. [Checks](../../tests/reminder-frequency.test.mjs).
 */
import { askFrequencyDecision } from '../telegram/frequency-confirmation.mjs';
import { readReminderFrequencyDecisions } from './frequency-decisions.mjs';
import { withAutonomyPauseLock } from './owner-pause.mjs';
import { fastReminderSpacing, reminderFrequencyChoice, reminderFrequencyFloor } from './reminder-frequency.mjs';
import { appendSavedActionRun, latestSavedActionRun } from './reminder-runs.mjs';
import { savedActionClaimIsCurrent, withCurrentSavedAction } from './reminder-store.mjs';

const failureMarker = 'применить не удалось';

function hourlyAction(action) {
  const next = { ...action, enabled: true, trigger: { kind: 'cron', cron: '0 * * * *' } };
  if (action.disabledReason === 'spent_once' || action.disabledReason === 'owner') delete next.disabledReason;
  for (const key of ['lastRunAt', 'lastStatus', 'lastOutcome', 'nextFireAt', 'pendingReschedule']) delete next[key];
  return next;
}

function chosenChange(action, choice) {
  const hourly = choice === 'hourly';
  const label = hourly ? 'раз в час' : 'выключить задачу';
  const prefix = 'решение владельца «' + label + '»';
  const name = '«' + action.name + '»';
  return {
    next: hourly ? hourlyAction(action) : { ...action, enabled: false, disabledReason: 'owner' },
    detail: prefix + ' применено: ' + (hourly ? 'расписание задачи изменено' : 'снята с работы, но не удалена'),
    notice: '✔ Готово: ' + name + (hourly ? ' теперь идёт раз в час, в начале каждого часа. Сейчас верну её в расписание.'
      : ' выключил. Из списка задача не пропала, скажи слово и включу обратно.'),
    retryNotice: '📡 Твой выбор по задаче ' + name + ' пока не применился: ' +
      (hourly ? 'перевести на раз в час' : 'выключить') +
      ' не вышло. Буду повторять. Задача до этого момента с расписания снята и денег не тратит.',
    failure: error => prefix + ' ' + failureMarker + ' (' + error + ')',
  };
}

function frequencyChange(action, minutes, choice) {
  const held = action.disabledReason === 'frequency';
  if (minutes === undefined || choice === 'keep_as_is') {
    if (!held) return;
    const next = { ...action };
    delete next.disabledReason;
    return {
      next,
      detail: 'тормоз «частота» снят, задача снова в работе',
      notice: '✔ Автономное действие «' + action.name + '» снова в расписании — ограничение (частота) снято.',
      failure: error => 'снять тормоз «частота» НЕ УДАЛОСЬ (' + error + '): задача осталась придержанной, повтор следующим тиком',
    };
  }
  if (choice === 'hourly' || choice === 'turn_off') return chosenChange(action, choice);
  if (held) return { ask: minutes };
  return {
    next: { ...action, disabledReason: 'frequency' },
    ask: minutes,
    detail: 'тормоз «частота»: слишком часто: каждые ' + minutes + ' мин при нижней границе ' +
      reminderFrequencyFloor + ' мин — каждый запуск стоит денег. Задача придержана до решения владельца',
    failure: error => 'тормоз «частота» НЕ СРАБОТАЛ (' + error + '): задача осталась в работе, повтор следующим тиком',
  };
}

async function reconcileAction(action, save, minutes) {
  const decisions = minutes === undefined ? {} : await readReminderFrequencyDecisions();
  const change = frequencyChange(action, minutes, reminderFrequencyChoice(action, decisions));
  if (!change) return;
  if (change.next) {
    try { await save(change.next); }
    catch (error) {
      return {
        result: { status: 'blocked', detail: change.failure(error.code || error.name) },
        retryNotice: change.retryNotice,
      };
    }
  }
  return { action: change.next ?? action, ask: change.ask, notice: change.notice,
    result: change.next ? { status: 'skipped', detail: change.detail } : undefined };
}

export async function applyReminderFrequencyBrake({ file, actions }, {
  api, now, log, signal, supports, destination, withLocalState, notify,
}) {
  const at = new Date(now()).toISOString();
  let visited = false;
  for (const snapshot of actions) {
    if (signal.aborted) break;
    if (!snapshot.enabled || snapshot.budget?.killSwitch) continue;
    const minutes = fastReminderSpacing(snapshot);
    if (minutes === undefined && snapshot.disabledReason !== 'frequency') continue;
    visited = true;
    try {
      const change = await withAutonomyPauseLock(() => withCurrentSavedAction(file, snapshot, async (action, save) => {
        const target = await destination();
        if (!target) return;
        return withLocalState(async state => {
          if (!supports(action, state)) return;
          const outcome = await reconcileAction(action, save, minutes);
          if (outcome) return { ...outcome, chat: target.chat };
        });
      }));
      if (!change) continue;
      let notice = change.notice;
      if (change.retryNotice) {
        const previous = await latestSavedActionRun(snapshot.id, 60);
        if (previous?.status !== 'blocked' || !String(previous.detail).includes(failureMarker)) notice = change.retryNotice;
      }
      if (change.result) await appendSavedActionRun(snapshot, at, change.result,
        { costVisible: true, format: snapshot.output?.format }).catch(error => {
        log('[msb/reminder] Could not append frequency result: ' + (error.code || error.name));
      });
      if (notice) await notify(change.chat, notice).catch(() => log('[msb/reminder] Could not send frequency notice'));
      if (change.ask !== undefined) {
        await askFrequencyDecision(api, change.chat, change.action, change.ask, {
          now, signal, isAllowed: async () => {
            const target = await destination();
            return target?.chat === change.chat && supports(change.action, target.state) &&
              await savedActionClaimIsCurrent(file, change.action);
          },
        });
      }
    } catch (error) {
      log('[msb/reminder] Could not process frequency decision: ' + (error.code || error.name));
    }
  }
  return visited;
}
