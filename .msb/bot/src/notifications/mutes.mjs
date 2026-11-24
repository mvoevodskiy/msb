/**
 * Read-only view of the legacy notice-mute.json choices for Settings.
 * The bot-scoped record lives beside sessions. The monitor record is shared.
 * [Telegram route](../telegram/routes/settings.mjs) and
 * [scope checks](../../tests/notification-settings.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import profile from '../../shared/profile.cjs';
import { actionRoot, botId, msbRoot } from '../paths.mjs';
import { monitorDir } from '../monitor/config.mjs';

async function readMuteFile(directory) {
  try {
    const { kinds } = JSON.parse(await fs.readFile(path.join(directory, 'notice-mute.json'), 'utf8'));
    return kinds && typeof kinds === 'object' && !Array.isArray(kinds) ? kinds : null;
  } catch (error) {
    return error?.code === 'ENOENT' ? undefined : null;
  }
}

async function readBotMutes(env) {
  const scoped = await readMuteFile(actionRoot(env));
  if (scoped !== undefined || profile.resolveProfile(env).id !== 'jar1'
    || botId(env) !== 'default' || profile.envValue(env, 'MSB_SESSION_DIR')) return scoped;
  // The old single-bot entrypoint defaulted to ~/.iia/sessions.
  return readMuteFile(msbRoot(env));
}

export async function readNoticeMutes(env = process.env) {
  const [shared, bot] = await Promise.all([readMuteFile(monitorDir(env)), readBotMutes(env)]);
  const notices = [
    [shared?.balance, 'Предупреждение о балансе мониторинга'],
    [bot?.provider_credits, 'Сообщение «кончились деньги у провайдера»'],
    [bot?.pause_reminder, 'Напоминание о паузе автономки'],
  ];
  return {
    labels: notices.filter(([record]) => typeof record?.mutedAt === 'string').map(([, label]) => label),
    complete: shared !== null && bot !== null,
  };
}
