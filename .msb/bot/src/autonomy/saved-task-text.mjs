/**
 * Old Iz/Nz/$z text rules. [Owner writer](./saved-task-text-edit.mjs)
 * stores the body and [scheduler completion](./reminder-store.mjs) recognizes
 * the same edited field. [Telegram checks](../../tests/task-text-edit.test.mjs).
 */
import { asksToScheduleAnotherTask, savedWorkBody } from './prompt-registration.mjs';

export const taskTextOperations = {
  EDIT_TASK: {
    malformed: 'Не понял, какой задаче какой текст ставить — скажи ещё раз.',
    query: 'Уточни, у какой задачи менять текст.',
    empty: 'Новый текст пуст. Скажи целиком, что задача должна делать, — и я заменю.',
    selfScheduling: 'Не поменял: новый текст просит ПОСТАВИТЬ задачу, а не делает работу — в назначенный час она заведёт ещё одну вместо дела. Начни с самой работы: «собери…», «проверь…», «напомни…».',
    failure: 'Не удалось заменить текст.',
    done: name => 'Готово: у «' + name + '» новый текст.',
    spent: name => 'Заменил текст «' + name + '».',
  },
  APPEND_TASK: {
    malformed: 'Не понял, какой задаче что дописать — скажи ещё раз.',
    query: 'Уточни, к какой задаче дописывать.',
    empty: 'Нечего дописывать: скажи, какую строку добавить, — и допишу в конец.',
    selfScheduling: 'Не дописал: добавка просит ПОСТАВИТЬ задачу, а не делает работу — в назначенный час она заведёт ещё одну вместо дела. Скажи саму работу: «собери…», «проверь…», «напомни…».',
    failure: 'Не удалось дописать.',
    done: name => 'Готово: дописал в «' + name + '».',
    spent: name => 'Дописал в «' + name + '».',
  },
  DROP_FROM_TASK: {
    malformed: 'Не понял, из какой задачи что убрать — скажи ещё раз.',
    query: 'Уточни, из какой задачи убрать.',
    empty: 'Скажи, что именно убрать из текста задачи.',
    selfScheduling: 'Не убрал: без этой строки текст просит ПОСТАВИТЬ задачу, а не делает работу. Скажи, каким текст должен стать, — заменю целиком.',
    failure: 'Не удалось убрать строку.',
    done: name => 'Готово: поправил «' + name + '».',
    spent: name => 'Убрал из «' + name + '».',
  },
};

export function taskBodyField(task) {
  if (task?.kind === 'reminder') return 'text';
  if (task?.kind === 'prompt' || task?.kind === 'draft') return 'prompt';
}

function normalizedMatch(value) {
  return value.toLowerCase().replace(/[«»"'\x60.,;:!?()\[\]]/g, '').replace(/\s+/g, ' ').trim();
}

function dropText(body, query, name) {
  const needle = normalizedMatch(query);
  const multiline = body.includes('\n');
  const parts = multiline ? body.split('\n') : body.split(/(?<=[.!?…])\s+/);
  const kept = [], removed = [];
  for (const part of parts) {
    if (needle && part.trim() && normalizedMatch(part).includes(needle)) removed.push(part.trim());
    else kept.push(part);
  }
  if (!removed.length) return { error: 'Не нашёл в «' + name + '» ничего про «' + query + '». Вот её текст целиком:\n' + body };
  const text = kept.join(multiline ? '\n' : ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return { error: 'Так у «' + name + '» не останется текста вовсе, а без него задача не знает, что делать. ' +
    'Если она больше не нужна — скажи «снеси ' + name + '»; если нужен другой текст — продиктуй его целиком.' };
  return { text, removed };
}

export function planSavedTaskText(action, operation, input) {
  const field = taskBodyField(action.task);
  const previous = action.task?.[field];
  if (!field || (operation !== 'EDIT_TASK' && typeof previous !== 'string')) {
    return { error: 'У «' + action.name + '» свободного текста нет — она собирает материал сама. Могу поставить рядом сбор с твоим текстом.' };
  }
  let change;
  if (operation === 'DROP_FROM_TASK') {
    change = dropText(previous, input, action.name);
  } else {
    const work = field === 'prompt' ? savedWorkBody(input) : input;
    change = { text: operation === 'APPEND_TASK' ? previous.trim() + '\n' + work : work };
  }
  if (change.error) return change;
  if (asksToScheduleAnotherTask(change.text)) return { error: taskTextOperations[operation].selfScheduling };
  return { ...change, field };
}
