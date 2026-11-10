/**
 * [Menu callbacks](./integration/callbacks.mjs) → store и native config выбранного профиля.
 * [Profile checks](./tests/codex-profile-preferences.test.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setSelectedModel, setSelectedEffort, storePath } from './store.mjs';
import { withCodexConfig } from './codex-config-write.mjs';
import { physicalFilePath } from '../shared/physical-file-path.mjs';
import { resolveSelectedCodexProfileDir } from '../shared/codex-profile.mjs';
import { readBotState } from './paths.mjs';
import { wireQwenAuth } from './auth-wire.mjs';
import { readEnvKey } from './env.mjs';

function upsertTomlScalar(text, key, value) {
  const tableAt = text.search(/^\s*\[/m);
  const tail = tableAt < 0 ? '' : text.slice(tableAt);
  text = tableAt < 0 ? text : text.slice(0, tableAt);
  const line = `${key} = ${JSON.stringify(value)}`;
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm');
  if (re.test(text)) text = text.replace(re, () => line);
  else {
    const body = text.trimEnd();
    text = body ? `${body}\n\n${line}\n` : `${line}\n`;
  }
  return text + tail;
}

async function saveCodexPreference(setSelection, key, value, env, home) {
  const state = await readBotState(env, home);
  const config = path.join(await resolveSelectedCodexProfileDir(state, env, home), 'config.toml');
  // Both paths are locked in this order. Session updates only take the store lock.
  let published = false;
  try {
    await withCodexConfig(config, async (text, save, file) => {
      if (file === await physicalFilePath(storePath(env, home))) throw new Error('config.toml совпадает с файлом настроек бота.');
      await setSelection('codex', value, env, home, {
        commit: publishStore => save(upsertTomlScalar(text, key, value), async () => {
          await publishStore();
          published = true;
        }),
      });
    });
  } catch (error) {
    if (!published) throw error;
    console.error('[msb/ext/codex] preference committed, lock cleanup failed:', error.code || error.name);
  }
}

async function upsertQwenModel(modelId, env, home) {
  const key =
    (await readEnvKey('QWEN_API_KEY', env, home)) ||
    (await readEnvKey('DASHSCOPE_API_KEY', env, home));
  if (key) {
    await wireQwenAuth(key, home);
  }
  const settingsPath = path.join(home, '.qwen', 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (!settings.model || typeof settings.model !== 'object') settings.model = {};
  settings.model.name = modelId;
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/**
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function applyProviderModel(providerId, modelId, env = process.env, home = env.HOME || os.homedir()) {
  const id = String(modelId || '').trim();
  if (!id) return { ok: false, error: 'пустой id модели' };

  try {
    if (providerId === 'codex') {
      await saveCodexPreference(setSelectedModel, 'model', id, env, home);
    } else {
      await setSelectedModel(providerId, id, env, home);
      if (providerId === 'qwen') await upsertQwenModel(id, env, home);
    }
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
  return { ok: true };
}

const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function applyProviderEffort(providerId, effort, env = process.env, home = env.HOME || os.homedir()) {
  const id = String(effort || '').trim();
  if (providerId !== 'codex') {
    return { ok: false, error: 'глубина настраивается только у Codex' };
  }
  if (!CODEX_EFFORTS.has(id)) return { ok: false, error: `неизвестный уровень: ${id}` };
  try {
    await saveCodexPreference(setSelectedEffort, 'model_reasoning_effort', id, env, home);
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
  return { ok: true };
}
