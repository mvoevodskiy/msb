/**
 * Task removal from a successful owner [turn](../telegram/task-removal-markers.mjs)
 * or a durable [question](../telegram/task-removal-confirmation.mjs). The
 * [action store](./reminder-store.mjs) locks the file and rechecks definitions.
 * [Spent](../../tests/spent-task-cleanup.test.mjs) and [named](../../tests/named-task-cancellation.test.mjs) checks.
 */
import path from 'node:path';
import { withFileLock } from '../../shared/file-lock.mjs';
import { botRoot } from '../paths.mjs';
import { loadState, NO_STATE_WRITE, updateState } from '../state.mjs';
import { readRecordArray, writeRecordArray } from './record-file.mjs';
import { readReminderPolicy } from './reminder-policy.mjs';
import { cancelNamedSavedTasks, removeConfirmedNamedTask, removeSpentTasks } from './reminder-store.mjs';

// Keep the deployed path and the original untyped spent-question records.
const questionsPath = () => path.join(botRoot(), 'autonomy', 'spent-task-questions.json');
const spentCallback = 'ct-spent';
const keepCallback = 'ct-keep';

export class TaskRemovalRefusal extends Error {}

async function requireRemovalRoute(state, turn) {
  const policy = await readReminderPolicy(state);
  if (!policy.enabled) throw new TaskRemovalRefusal('Автономные задачи сейчас выключены.');
  const engine = state.engine || 'cc';
  const allowed = turn ? ['cc', 'oc'].includes(turn.rail) && turn.rail === engine : policy.local && !policy.asleep;
  if (!allowed) throw new TaskRemovalRefusal((turn?.named ? 'Отмена' : 'Уборка') + ' задач на этом движке пока не подключена.');
}

async function commitRemoval(publish, turn) {
  let result;
  await updateState(async state => {
    await requireRemovalRoute(state, turn);
    result = await publish();
    return NO_STATE_WRITE;
  });
  return result;
}

export function cleanupSpentTasksFromTurn({ rail, signal }) {
  return removeSpentTasks({ rail, signal, commit: publish => commitRemoval(publish, { rail }) });
}

export function cancelNamedTaskFromTurn(query, { rail, signal }) {
  return cancelNamedSavedTasks(query, { rail, signal, commit: publish => commitRemoval(publish, { rail, named: true }) });
}

function questionTurn(question) {
  return question.kind === 'named' ? { rail: question.rail, named: true } : undefined;
}

export function saveTaskRemovalQuestion(question, signal) {
  const file = questionsPath();
  return withFileLock(file, async () => {
    await requireRemovalRoute((await loadState()).state, questionTurn(question));
    const questions = await readRecordArray(file);
    await writeRecordArray(file, [...questions, question], { create: true, signal });
  });
}

export async function resolveTaskRemovalQuestion({ ownerId, chatId, messageId }, callback = keepCallback) {
  const file = questionsPath();
  const keep = callback === keepCallback;
  const matches = question => question?.ownerId === ownerId && question.chatId === chatId && question.messageId === messageId &&
    (question.kind === 'named' ? keep || question.callback === callback :
      question.kind === undefined && (keep || callback === spentCallback));
  // Shared Keep can belong to another confirmation. It must not create a file.
  if (!(await readRecordArray(file)).some(matches)) return null;
  return withFileLock(file, async () => {
    const questions = await readRecordArray(file);
    const question = questions.find(matches);
    if (!question) return null;
    const consume = () => writeRecordArray(file, questions.filter(row => row !== question));
    if (keep) {
      await consume();
      return { kept: true };
    }
    // Keep a failed or interrupted action write retryable.
    const turn = questionTurn(question);
    const result = turn
      ? await removeConfirmedNamedTask(question, { rail: turn.rail, commit: publish => commitRemoval(publish, turn) })
      : await removeSpentTasks({ snapshot: question, commit: commitRemoval });
    if (turn && result?.failed.length) return { named: true, ...result };
    await consume().catch(error => {
      console.error('[msb/autonomy] Could not retire task removal question:', error.code || error.name);
    });
    return { named: Boolean(turn), ...(result ?? { removed: [], failed: [], changed: true }) };
  }).catch(error => {
    if (keep) return { keepFailed: true };
    throw error;
  });
}
