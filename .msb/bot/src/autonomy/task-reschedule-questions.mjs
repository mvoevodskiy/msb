/**
 * Per-bot pending proposals for [Telegram](../telegram/task-reschedule-confirmation.mjs).
 * The durable message binding does not touch actions.json while a task runs.
 * Resolve under the question lock, then let the [writer](./saved-task-reschedule.mjs)
 * check the exact definition. [Checks](../../tests/task-reschedule.test.mjs).
 */
import path from 'node:path';
import { withFileLock } from '../../shared/file-lock.mjs';
import { botRoot } from '../paths.mjs';
import { readRecordArray, writeRecordArray } from './record-file.mjs';
import { applyTaskReschedule } from './saved-task-reschedule.mjs';

const questionsPath = env => path.join(botRoot(env), 'autonomy', 'task-reschedule-questions.json');
const keep = 'ct-keep';

export function armTaskRescheduleQuestion(question, expose, { signal, env = process.env } = {}) {
  const file = questionsPath(env);
  return withFileLock(file, async () => {
    const previous = (await readRecordArray(file)).filter(row => !row?.publishing);
    const supersedes = row => row?.file === question.file && row.id === question.id;
    // Bind the new message before exposing its buttons. A tap waits for this
    // bounded publication, and the old card stays usable if it fails.
    await writeRecordArray(file, [...previous, { ...question, publishing: true }], { create: true, signal });
    try {
      await expose();
      await writeRecordArray(file, [...previous.filter(row => !supersedes(row)), question], { signal });
    } catch (error) {
      await writeRecordArray(file, previous).catch(restoreError => {
        console.error('[msb/autonomy] Could not restore reschedule questions:', restoreError.code || restoreError.name);
      });
      throw error;
    }
  });
}

export async function resolveTaskRescheduleQuestion({ ownerId, chatId, messageId }, callback = keep,
  { timezone, env = process.env } = {}) {
  const file = questionsPath(env);
  const matches = row => row?.ownerId === ownerId && row.chatId === chatId && row.messageId === messageId &&
    (callback === keep || row.callback === callback);
  // Keep is shared with other menus. Don't lock or create an unused book.
  if (!(await readRecordArray(file)).some(matches)) return null;
  return withFileLock(file, async () => {
    const rows = await readRecordArray(file);
    const question = rows.find(matches);
    if (!question) return null;
    const retire = () => writeRecordArray(file, rows.filter(row => row !== question));
    if (callback === keep) {
      return retire().then(() => ({ kept: true }), () => ({ keepFailed: true }));
    }
    // After a process exit during publication only the prior card is armed.
    const result = question.publishing ? { stale: true }
      : await applyTaskReschedule(question, { timezone, env }) ?? { stale: true };
    if (!result.error) {
      // A successful write changed the definition even for identical cron.
      // If retirement fails, the old card can no longer apply that write.
      await retire().catch(error => {
        console.error('[msb/autonomy] Could not retire reschedule question:', error.code || error.name);
      });
    }
    return result;
  });
}
