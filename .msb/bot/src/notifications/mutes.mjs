/**
 * Legacy notice preferences and the shared Telegram mute button.
 * Bot preferences live beside sessions and balance preferences in the monitor.
 * Writers serialize by physical file path and preserve unrelated saved data.
 * [Telegram callbacks](../telegram/routes/notifications.mjs),
 * [scope and handler checks](../../tests/notification-settings.test.mjs).
 */
import path from 'node:path';
import profile from '../../shared/profile.cjs';
import { withFileLock } from '../../shared/file-lock.mjs';
import { physicalFilePath } from '../../shared/physical-file-path.mjs';
import { actionRoot, botId, msbRoot } from '../paths.mjs';
import { monitorDir } from '../monitor/config.mjs';
import { readOptionalJson, writeRecordJson } from '../autonomy/record-file.mjs';

export const NOTICE_KINDS = Object.freeze({
  balance: Object.freeze({ name: 'предупреждение о балансе мониторинга', short: 'баланс мониторинга', scope: 'server' }),
  provider_credits: Object.freeze({ name: 'сообщение «кончились деньги у провайдера»', short: 'деньги у провайдера' }),
  pause_reminder: Object.freeze({ name: 'напоминание о паузе автономки', short: 'пауза автономки' }),
});

export function noticeMuteKeyboard(kind, rows = []) {
  return { inline_keyboard: [...rows, [{ text: '🔕 Больше не присылать', callback_data: `nm:${kind}` }]] };
}

function mutePath(directory) {
  return path.join(directory, 'notice-mute.json');
}

function legacyBotPath(env) {
  if (profile.resolveProfile(env).id === 'jar1' && botId(env) === 'default'
    && !profile.envValue(env, 'MSB_SESSION_DIR')) return mutePath(msbRoot(env));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readMutes(file) {
  const value = await readOptionalJson(file);
  if (value !== undefined && (!isObject(value) || !isObject(value.kinds))) {
    throw new Error('Invalid notice mute preferences');
  }
  return value;
}

async function readBotMutes(env) {
  const scoped = await readMutes(mutePath(actionRoot(env)));
  const fallback = legacyBotPath(env);
  return scoped ?? (fallback ? readMutes(fallback) : undefined);
}

function isMuted(preferences, kind) {
  return typeof preferences?.kinds[kind]?.mutedAt === 'string';
}

export async function isNoticeMuted(kind, env = process.env) {
  if (!Object.hasOwn(NOTICE_KINDS, kind)) return false;
  const preferences = NOTICE_KINDS[kind].scope === 'server'
    ? readMutes(mutePath(monitorDir(env))) : readBotMutes(env);
  return isMuted(await preferences.catch(() => null), kind);
}

export async function readNoticeMutes(env = process.env) {
  const [shared, bot] = await Promise.all([
    readMutes(mutePath(monitorDir(env))).catch(() => null),
    readBotMutes(env).catch(() => null),
  ]);
  return {
    kinds: Object.keys(NOTICE_KINDS).filter(kind =>
      isMuted(NOTICE_KINDS[kind].scope === 'server' ? shared : bot, kind)),
    complete: shared !== null && bot !== null,
  };
}

export async function setNoticeMuted(kind, muted, now = Date.now(), env = process.env) {
  if (!Object.hasOwn(NOTICE_KINDS, kind)) throw new Error('Unknown notice kind');
  const shared = NOTICE_KINDS[kind].scope === 'server';
  const scoped = await physicalFilePath(mutePath(shared ? monitorDir(env) : actionRoot(env)));

  const update = async (file, preferences) => {
    if (isMuted(preferences, kind) === muted) return false;
    const value = preferences ?? { kinds: {} };
    if (muted) value.kinds[kind] = { ...value.kinds[kind], mutedAt: new Date(now).toISOString() };
    else {
      delete value.kinds[kind].mutedAt;
      if (!Object.keys(value.kinds[kind]).length) delete value.kinds[kind];
    }
    await writeRecordJson(file, value, { create: true });
    return true;
  };

  return withFileLock(scoped, async () => {
    const preferences = await readMutes(scoped);
    const fallbackPath = shared ? undefined : legacyBotPath(env);
    if (preferences !== undefined || !fallbackPath) return update(scoped, preferences);

    // Changes to an existing legacy file remain visible to readers of that file.
    // Hold the bot's scoped lock while choosing the authoritative file.
    const fallback = await physicalFilePath(fallbackPath);
    if (fallback === scoped) return update(scoped, preferences);
    return withFileLock(fallback, async () => {
      const legacy = await readMutes(fallback);
      return legacy === undefined ? update(scoped, preferences) : update(fallback, legacy);
    });
  });
}
