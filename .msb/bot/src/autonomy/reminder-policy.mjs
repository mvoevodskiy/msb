/**
 * Read-only per-bot autonomy flags from the old action profile.
 * [Model protocol](./reminder-protocol.mjs), [delivery](./reminder-dispatch.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { actionRoot, botId, msbRoot } from '../paths.mjs';
import { readAutonomyPause } from './owner-pause.mjs';
import { readOptionalJson } from './record-file.mjs';

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
  const [config, pause, asleep] = await Promise.all([
    readOptionalJson(path.join(root, 'autonomy', 'config.json')),
    readAutonomyPause(env),
    exists(path.join(msbRoot(env), 'engine', 'sleep.' + botId(env))),
  ]);
  const { remote, stopped, ownerStopped, fleetStopped } = pause;
  const local = isLocalReminderEngine(state.engine);
  const autoFlag = state.engine === 'oc' ? remote?.autonomyAutoOnOc : remote?.autonomyAutoOnCc;
  const enabled = env.AUTONOMY_ENABLED === undefined
    ? (config?.enabled === undefined ? autoFlag : config.enabled) === true
    : ['1', 'true'].includes(env.AUTONOMY_ENABLED.toLowerCase());
  const rawReserve = env.AUTONOMY_RESERVE_FRACTION === undefined
    ? config?.reserveFraction : Number(env.AUTONOMY_RESERVE_FRACTION);
  const reserveFraction = Number.isFinite(rawReserve) ? Math.min(0.9, Math.max(0, rawReserve)) : 0.3;
  return { enabled, local, stopped, ownerStopped, fleetStopped, asleep, reserveFraction };
}
