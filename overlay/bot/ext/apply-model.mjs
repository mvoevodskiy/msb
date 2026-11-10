/**
 * [Menu callbacks](./integration/callbacks.mjs) → store и native config выбранного профиля.
 * [Profile checks](./tests/codex-profile-preferences.test.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setSelectedModel, setSelectedEffort } from './store.mjs';
import { resolveSelectedCodexProfileDir } from '../shared/codex-profile.mjs';
import { readBotState } from './paths.mjs';
import { wireQwenAuth } from './auth-wire.mjs';
import { readEnvKey } from './env.mjs';

export async function upsertTomlScalar(file, key, value) {
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
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
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, text + tail, { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function selectedCodexConfigPath(env, home) {
  const state = await readBotState(env, home);
  return path.join(await resolveSelectedCodexProfileDir(state, env, home), 'config.toml');
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
    const config = providerId === 'codex' ? await selectedCodexConfigPath(env, home) : null;
    await setSelectedModel(providerId, id, env, home);
    if (config) {
      await upsertTomlScalar(config, 'model', id);
    } else if (providerId === 'qwen') {
      await upsertQwenModel(id, env, home);
    }
    // Cursor: достаточно store + --model в адаптере
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
    const config = await selectedCodexConfigPath(env, home);
    await setSelectedEffort(providerId, id, env, home);
    await upsertTomlScalar(config, 'model_reasoning_effort', id);
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
  return { ok: true };
}
