/**
 * JSON and physical profile proof for a local OpenClaw Gateway.
 * [Profile](./openclaw-profile.mjs) checks ownership, [CLI](./openclaw-read.mjs)
 * runs the bounded command. Used by [MCP](../mcp/openclaw-setup.mjs)
 * and [saved native reminders](../autonomy/openclaw-reminder-cron.mjs).
 */
import fs from 'node:fs/promises';
import { runOpenClawCommand } from './openclaw-read.mjs';
import { ownedOpenClawProfile, openClawProfileEnvironment } from './openclaw-profile.mjs';

export function openClawCommandJson(outcome) {
  if (outcome?.code !== 0) return null;
  try { return JSON.parse(outcome.text); }
  catch { return null; }
}

export async function readOpenClawJson(args, options) {
  return openClawCommandJson(await runOpenClawCommand(args, options));
}

export async function readOpenClawGatewayConfig(profile, options) {
  const reply = await readOpenClawJson(['gateway', 'call', 'config.get', '--json'], options);
  if (typeof reply?.path !== 'string' || await fs.realpath(reply.path).catch(() => null) !== profile.file) return null;
  return reply.config ?? null;
}

export async function openOwnedLocalGateway(env, { expectedFile, signal } = {}) {
  const profile = await ownedOpenClawProfile(env);
  if (!profile || expectedFile && profile.file !== expectedFile) return;
  const options = { env: openClawProfileEnvironment(env, profile), timeoutMs: 15_000 };
  const readOptions = { ...options, signal };
  if (await readOpenClawJson(['config', 'get', 'gateway.mode', '--json'], readOptions) !== 'local' ||
      !await readOpenClawGatewayConfig(profile, readOptions)) return;
  return { file: profile.file, run: (args, signal) => readOpenClawJson(args, { ...options, signal }),
    command: args => runOpenClawCommand(args, options) };
}
