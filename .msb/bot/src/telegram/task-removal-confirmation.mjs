/**
 * Old buttons for a named [CANCEL_TASK](./task-removal-markers.mjs) or
 * CANCEL_ALL, and the spent group in [LIST_TASKS](./task-inspection-markers.mjs).
 * [Owner transport](./owner-confirmation.mjs) arms the question. [Router](./router.mjs)
 * resolves it through the [profile binding](../autonomy/task-removal.mjs).
 * [Ingress checks](../../tests/named-task-cancellation.test.mjs).
 */
import { InlineKeyboard } from 'grammy';
import { listLegacyTimers } from '../autonomy/legacy-timers.mjs';
import { resolveTaskRemovalQuestion, saveTaskRemovalQuestion, TaskRemovalRefusal } from '../autonomy/task-removal.mjs';
import { nameReference } from '../../shared/callback-ref.mjs';
import { closeOwnerQuestion, deliverOwnerQuestion } from './owner-confirmation.mjs';

const confirm = 'ct-spent';
const confirmAll = 'ct-all';
const keep = 'ct-keep';
const plural = new Intl.PluralRules('ru');

const namedPrefix = 'ct:';

export function isTaskRemovalConfirmation(data) {
  return data === confirm || data === confirmAll || data.startsWith(namedPrefix);
}

export function askToCancelSavedTask(ctx, { action, snapshot }, schedule, { ownerId, rail, threadId, signal }) {
  const callback = namedPrefix + nameReference(action.id, { marker: 'a~', actionPrefix: namedPrefix });
  const owner = Number(ownerId);
  return deliverOwnerQuestion(ctx, {
    text: 'Снести фоновую задачу «' + action.name + '»?\nСработает ' + schedule + '. Снос необратим.',
    keyboard: new InlineKeyboard().text('Снести ✖', callback).text('Оставить', keep),
    threadId, signal,
    save: binding => saveTaskRemovalQuestion({ ...binding, ...snapshot, ownerId: owner, kind: 'named', callback, rail }, signal),
    discard: binding => resolveTaskRemovalQuestion({ ...binding, ownerId: owner }),
  });
}

export function askToCancelAllTasks(ctx, { names, snapshot }, { ownerId, rail, threadId, signal }) {
  const lines = ['Снести все фоновые задачи (' + names.length + ')?'];
  if (names.length <= 10) lines.push(...names.map(name => '• ' + name));
  lines.push('Снос необратим.');
  const owner = Number(ownerId);
  return deliverOwnerQuestion(ctx, {
    text: lines.join('\n'),
    keyboard: new InlineKeyboard().text('Снести все ✖', confirmAll).text('Оставить', keep),
    threadId, signal,
    save: binding => saveTaskRemovalQuestion({ ...binding, ...snapshot, ownerId: owner, kind: 'all', rail }, signal),
    discard: binding => resolveTaskRemovalQuestion({ ...binding, ownerId: owner }),
  });
}

export function askToClearSpentTasks(ctx, file, candidates, { ownerId, threadId, signal }) {
  const count = candidates.length;
  const word = { one: 'просроченную', few: 'просроченные', many: 'просроченных' }[plural.select(count)];
  return deliverOwnerQuestion(ctx, {
    text: 'Убрать из списка ' + count + ' ' + word + '? Они уже не сработают.',
    keyboard: new InlineKeyboard().text('Убрать ✖', confirm).text('Оставить', keep),
    threadId, signal,
    save: binding => saveTaskRemovalQuestion({ ...binding, ownerId: Number(ownerId), file, candidates }, signal),
    discard: binding => resolveTaskRemovalQuestion({ ...binding, ownerId: Number(ownerId) }),
  });
}

export function describeSpentTaskCleanup(result) {
  const { removed, failed, changed } = result;
  const lines = [];
  if (removed.length) lines.push('Снёс ' + removed.length + ', они уже не могли сработать:\n' +
    removed.map(name => '✖ ' + name).join('\n'));
  if (failed.length) lines.push('⚠ Не удалось снять: ' + failed.join(', ') + '.');
  if (changed) lines.push('Список изменился. Покажи задачи ещё раз.');
  if (!lines.length) lines.push('Сносить нечего — всё, что есть, ещё сработает.');
  const toast = changed && !removed.length && !failed.length ? 'Подтверждение устарело' :
    failed.length || changed ? 'Убрал не всё' : 'Убрал';
  return { toast, text: lines.join('\n\n') };
}

function namedResponse(result) {
  if (result.removed.length) return { toast: 'Снёс', text: '✖ Снёс «' + result.removed[0] + '»' };
  if (result.missing) return { toast: 'Этой задачи уже нет', text: 'Этой задачи уже нет.' };
  return { toast: 'Подтверждение устарело', text: 'Подтверждение устарело.' };
}

const bulkFailures = {
  pause: 'Не удалось остановить автономку. Задачи сохранены.',
  archive: 'Не удалось сохранить снимок. Автономка на паузе, задачи сохранены.',
  remove: 'Не удалось снести задачи. Автономка на паузе, задачи сохранены.',
};

async function bulkResponse(result) {
  if (result.stale) return { toast: 'Подтверждение устарело', text: 'Список изменился. Покажи задачи ещё раз.' };
  const { removed, failed, archive, nativeMayStillRun } = result;
  const partial = failed.length > 0 || nativeMayStillRun;
  const lines = [];
  if (removed.length) {
    const subject = partial ? 'Отменил задачи' : 'Отменил все задачи';
    const pause = partial ? 'остановил локальную автономку' : 'остановил автономку';
    lines.push(subject + ' (' + removed.length + ') и ' + pause + ':\n' + removed.map(name => '• ' + name).join('\n'));
  } else {
    lines.push('⛔ Автономка остановлена.');
  }
  if (archive) lines.push('Снимок задач сохранён на сервере: ' + archive + '.');
  if (failed.length) lines.push('⚠ Не удалось снять: ' + failed.join(', ') + '.');
  if (nativeMayStillRun) lines.push('🔴 Задания OpenClaw могут продолжать срабатывать по своему расписанию.');
  if ((await listLegacyTimers().catch(() => [])).some(timer => timer.enabled)) {
    lines.push('Таймеры с прошлой настройки работают отдельно.');
  }
  return { toast: partial ? 'Снёс не всё' : 'Снёс', text: lines.join('\n\n') };
}

export async function handleTaskRemovalConfirmation({ cfg, ctx, data, chatId, msgId, answer, now }) {
  const remove = data !== keep;
  let result;
  try {
    result = await resolveTaskRemovalQuestion({ chatId, messageId: msgId, ownerId: Number(cfg.adminId) }, data, { now });
  } catch (error) {
    if (!remove) return false;
    const fallback = data === confirm ? 'Не смог убрать, попробуй ещё раз' : 'Не смог снести, попробуй ещё раз';
    await answer({ text: error instanceof TaskRemovalRefusal ? error.message : fallback, show_alert: true });
    return true;
  }
  if (!result && !remove) return false;
  if (result?.keepFailed) await answer({ text: 'Не смог закрыть вопрос, попробуй ещё раз', show_alert: true });
  else if (!result) await answer({ text: 'Подтверждение устарело' });
  else if (result.bulk && result.failure) {
    const note = result.archive ? ' Снимок сохранён.' : '';
    const failure = result.failure === 'pause' && result.paused
      ? 'Не удалось подтвердить запись паузы. Задачи сохранены.' : bulkFailures[result.failure];
    await answer({ text: failure + note, show_alert: true });
  } else if (result.named && result.failed.length) {
    await answer({ text: 'Не смог снять — попробуй ещё раз', show_alert: true });
  } else {
    const { toast, text } = result.kept ? { toast: 'Оставил', text: '✔ Оставил на месте' } :
      result.bulk ? await bulkResponse(result) : result.named ? namedResponse(result) : describeSpentTaskCleanup(result);
    await answer({ text: toast });
    await closeOwnerQuestion(ctx, chatId, msgId, text);
  }
  return true;
}
