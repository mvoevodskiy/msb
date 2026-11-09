/**
 * Own the delivered, single-use spent-task question for this bot. The
 * [Telegram card](../telegram/spent-task-confirmation.mjs) stores only row
 * identities; [action store](./reminder-store.mjs) rechecks them under its lock.
 * [Direct marker](../telegram/spent-task-markers.mjs) uses the same writer with current rows.
 * [Question tests](../../tests/spent-task-cleanup.test.mjs), [direct tests](../../tests/direct-spent-task-cleanup.test.mjs).
 */
import path from 'node:path';
import { withFileLock } from '../../shared/file-lock.mjs';
import { botRoot } from '../paths.mjs';
import { loadState, NO_STATE_WRITE, updateState } from '../state.mjs';
import { readRecordArray, writeRecordArray } from './record-file.mjs';
import { readReminderPolicy } from './reminder-policy.mjs';
import { removeSpentTasks } from './reminder-store.mjs';

const questionsPath = () => path.join(botRoot(), 'autonomy', 'spent-task-questions.json');

export class SpentCleanupRefusal extends Error {}

async function requireCleanupRoute(state, turn) {
  const policy = await readReminderPolicy(state);
  if (!policy.enabled) throw new SpentCleanupRefusal('Автономные задачи сейчас выключены.');
  const engine = state.engine || 'cc';
  const allowed = turn ? ['cc', 'oc'].includes(turn.rail) && turn.rail === engine : policy.local && !policy.asleep;
  if (!allowed) throw new SpentCleanupRefusal('Уборка задач на этом движке пока не подключена.');
}

async function commitCleanup(publish, turn) {
  let result;
  await updateState(async state => {
    await requireCleanupRoute(state, turn);
    result = await publish();
    return NO_STATE_WRITE;
  });
  return result;
}

export function cleanupSpentTasksFromTurn({ rail, signal }) {
  return removeSpentTasks({ rail, signal, commit: publish => commitCleanup(publish, { rail }) });
}

export function saveSpentTaskQuestion(question, signal) {
  const file = questionsPath();
  return withFileLock(file, async () => {
    await requireCleanupRoute((await loadState()).state);
    const questions = await readRecordArray(file);
    await writeRecordArray(file, [...questions, question], { create: true, signal });
  });
}

export async function resolveSpentTaskQuestion({ ownerId, chatId, messageId }, remove) {
  const file = questionsPath();
  const matches = question => question?.ownerId === ownerId && question.chatId === chatId && question.messageId === messageId;
  // Shared Keep can belong to another confirmation. It must not create a file.
  if (!(await readRecordArray(file)).some(matches)) return null;
  return withFileLock(file, async () => {
    const questions = await readRecordArray(file);
    const question = questions.find(matches);
    if (!question) return null;
    const consume = () => writeRecordArray(file, questions.filter(row => row !== question));
    if (!remove) {
      await consume();
      return { kept: true };
    }
    // Keep a failed or interrupted action write retryable. After a successful
    // write the same fingerprints can only match rows that are still present.
    const result = await removeSpentTasks({ snapshot: question, commit: commitCleanup });
    await consume().catch(error => {
      console.error('[msb/autonomy] Could not retire spent-task question:', error.code || error.name);
    });
    return result ?? { removed: [], failed: [], changed: true };
  }).catch(error => {
    if (!remove) return { keepFailed: true };
    throw error;
  });
}
