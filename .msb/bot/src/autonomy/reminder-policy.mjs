/**
 * Read-only per-bot autonomy flags from the old action profile.
 * [Model protocol](./reminder-protocol.mjs), [delivery](./reminder-dispatch.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { botId, msbRoot, sessionDir } from '../paths.mjs';
import { readOptionalJson } from './record-file.mjs';

export function actionRoot(env = process.env) {
  return path.resolve(path.dirname(sessionDir(env)));
}

export function isLocalReminderEngine(engine) {
  return engine === undefined || engine === 'cc';
}

export function reminderOwnerChat(state, adminId) {
  const chatId = Number(state.chatId);
  if (!adminId || Number(state.userId) !== Number(adminId) || !Number.isSafeInteger(chatId) || !chatId) return;
  return chatId;
}

async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readReminderPolicy(state, env = process.env) {
  const root = actionRoot(env);
  const [config, remote, stop, asleep] = await Promise.all([
    readOptionalJson(path.join(root, 'autonomy', 'config.json')),
    readOptionalJson(path.join(root, 'remote-config.json')),
    exists(path.join(root, 'autonomy', 'STOP')),
    exists(path.join(msbRoot(env), 'engine', 'sleep.' + botId(env))),
  ]);
  const local = isLocalReminderEngine(state.engine);
  const autoFlag = state.engine === 'oc' ? remote?.autonomyAutoOnOc : remote?.autonomyAutoOnCc;
  const enabled = env.AUTONOMY_ENABLED === undefined
    ? (config?.enabled === undefined ? autoFlag : config.enabled) === true
    : ['1', 'true'].includes(env.AUTONOMY_ENABLED.toLowerCase());
  return { enabled, local, stopped: stop || remote?.autonomyGlobalStop === true, asleep };
}
