/**
 * Per-bot owner binding for the [timer delete card](../telegram/legacy-timer-confirmation.mjs).
 * The [schedules writer](./legacy-timer-actions.mjs) verifies the approved row
 * under its file lock. [Delete and retry checks](../../tests/legacy-timer-conversation.test.mjs).
 */
import path from 'node:path';
import { withFileLock } from '../../shared/file-lock.mjs';
import { botRoot } from '../paths.mjs';
import { readRecordArray, writeRecordArray } from './record-file.mjs';
import { removeApprovedLegacyTimer } from './legacy-timer-actions.mjs';

const questionsPath = env => path.join(botRoot(env), 'autonomy', 'legacy-timer-delete-questions.json');
const keep = 'ct-keep';

export function saveLegacyTimerDeletion(question, { signal, env = process.env } = {}) {
  const file = questionsPath(env);
  return withFileLock(file, async () => {
    const rows = await readRecordArray(file);
    await writeRecordArray(file, [...rows, question], { create: true, signal });
  });
}

export async function settleLegacyTimerDeletion({ ownerId, chatId, messageId }, callback = keep,
  env = process.env) {
  const file = questionsPath(env);
  const matches = row => row?.ownerId === ownerId && row.chatId === chatId && row.messageId === messageId &&
    (callback === keep || row.callback === callback);
  // Shared Keep must pass through when another route owns the question.
  if (!(await readRecordArray(file)).some(matches)) return null;
  return withFileLock(file, async () => {
    const rows = await readRecordArray(file);
    const question = rows.find(matches);
    if (!question) return null;
    const retire = () => writeRecordArray(file, rows.filter(row => row !== question));
    if (callback === keep) return retire().then(() => ({ kept: true }), () => ({ keepFailed: true }));
    const retireAfterTap = () => retire().catch(error => {
      console.error('[msb/autonomy] Could not retire timer deletion question:', error.code || error.name);
    });
    if (question.applying) {
      await retireAfterTap();
      return { stale: true };
    }
    let applying = false;
    const begin = async () => {
      // A completed or interrupted delete cannot authorize a second delete
      // after the same definition is restored under the same ID.
      await writeRecordArray(file, rows.map(row => row === question ? { ...row, applying: true } : row), { durable: true });
      applying = true;
    };
    let result, published;
    try {
      result = await removeApprovedLegacyTimer(question, {
        begin,
        published: committed => { published = committed; },
      }, env);
    } catch (error) {
      if (published) {
        // The schedule rename succeeded before the lock release failed.
        console.error('[msb/autonomy] Could not release timer lock after deletion:', error.code || error.name);
        result = published;
      } else {
        // A failure before the atomic schedules rename leaves the timer intact.
        if (applying) await writeRecordArray(file, rows, { durable: true }).catch(restoreError => {
          console.error('[msb/autonomy] Could not rearm timer deletion:', restoreError.code || restoreError.name);
        });
        throw error;
      }
    }
    await retireAfterTap();
    return result;
  });
}
