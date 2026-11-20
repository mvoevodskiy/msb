/**
 * Per-bot native action ID → Gateway job ID and delivery state.
 * [Registration](./openclaw-reminder-registration.mjs) and [reconciliation](./openclaw-reminder-dispatch.mjs)
 * update the map under the [action lock](./reminder-store.mjs).
 * [Telegram](./saved-task-inspection.mjs) still reads legacy entries without changing them.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { actionRoot } from '../paths.mjs';
import { readOptionalJson, writeRecordJson } from './record-file.mjs';

const mapFile = env => path.join(actionRoot(env), 'autonomy', 'cron-jobs.json');

export async function readNativeJobMap(env) {
  const jobs = await readOptionalJson(mapFile(env));
  if (jobs === undefined) return {};
  if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) throw new Error('Expected native job mapping');
  return jobs;
}

export async function writeNativeJobMap(jobs, env) {
  const file = mapFile(env);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeRecordJson(file, jobs, { create: true, durable: true });
}
