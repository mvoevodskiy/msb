/**
 * Conversational limit writes reuse the [per-bot env writer](../env/store.mjs).
 * A pending zero is bound to one delivered question in the bot profile. Only
 * [owner callbacks](../telegram/limit-confirmation.mjs) resolve it. Consumers:
 * [admission](./reminder-admission.mjs), [policy](./reminder-policy.mjs),
 * [action creation](./reminder-store.mjs). [Tests](../../tests/autonomy-limit-control.test.mjs).
 */
import path from 'node:path';
import { withFileLock } from '../../shared/file-lock.mjs';
import { setEnvKey } from '../env/store.mjs';
import { botRoot } from '../paths.mjs';
import { loadState } from '../state.mjs';
import { limitDefinition } from './limit-protocol.mjs';
import { readRecordArray, writeRecordArray } from './record-file.mjs';
import { isLocalReminderEngine, readReminderPolicy } from './reminder-policy.mjs';

const questionsPath = () => path.join(botRoot(), 'autonomy', 'limit-questions.json');

export class LimitRouteRefusal extends Error {}

export async function requireLocalLimitRoute(rail) {
  const { state } = await loadState();
  const policy = await readReminderPolicy(state);
  if (!policy.enabled) throw new LimitRouteRefusal('Автономные задачи сейчас выключены.');
  if (rail !== 'cc' || !policy.local || policy.asleep || !isLocalReminderEngine((await loadState()).state.engine)) {
    throw new LimitRouteRefusal('Управление пределами автономки на этом движке пока не подключено.');
  }
}

export function setAutonomyLimit(key, value, { rail, signal }) {
  return setEnvKey(limitDefinition(key).env, String(value), process.env, {
    signal, beforePublish: () => requireLocalLimitRoute(rail),
  });
}

export async function saveLimitQuestion(question, signal) {
  const file = questionsPath();
  return withFileLock(file, async () => {
    signal?.throwIfAborted();
    const questions = await readRecordArray(file);
    await writeRecordArray(file, [...questions, question], { create: true, signal });
  });
}

export async function resolveLimitQuestion({ chatId, messageId }, key) {
  const file = questionsPath();
  const matches = question => question?.chatId === chatId && question.messageId === messageId &&
    (key === undefined || question.key === key) && limitDefinition(question.key);
  // In particular, the shared Keep button for a timer must not create a limit file.
  if (!(await readRecordArray(file)).some(matches)) return null;
  return withFileLock(file, async () => {
    const questions = await readRecordArray(file);
    const index = questions.findIndex(matches);
    if (index === -1) return null;
    const question = questions[index];
    if (key !== undefined) await requireLocalLimitRoute('cc');
    await writeRecordArray(file, questions.filter((_, position) => position !== index));
    if (key !== undefined) {
      try {
        await setAutonomyLimit(key, 0, { rail: 'cc' });
      } catch (error) {
        await writeRecordArray(file, questions).catch(() => {});
        throw error;
      }
    }
    return question;
  });
}
