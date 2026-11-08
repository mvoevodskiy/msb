import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, statePath } from './paths.mjs';

/**
 * Совместимый state.json с закрытым ядром и overlay/ext.
 * Канон полей (CONTRACT-state-menus): authMode, hasSubscriptionAuth, engine,
 * ccSessionId, ccModel, ccEffort, permissionMode, extAuthBypass.
 * Алиасы model/effort/permMode читаются для старых записей.
 * Вход: [Telegram](./telegram/bot.mjs), [agent](./agent/turn.mjs); записи только updateState.
 * Путь/profile → [paths](./paths.mjs), env CRUD → [env/store](./env/store.mjs).
 * Отдельные provider IDs/model/effort → [ext store](../../../overlay/bot/ext/store.mjs);
 * переключение бесед → [provider sessions](../../../overlay/bot/ext/provider-sessions.mjs).
 * Проверки: [paths/state](../tests/paths-state.test.mjs), [session races](../tests/turn-lifecycle.test.mjs).
 */
export async function loadState(env = process.env) {
  const file = statePath(env);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const state = JSON.parse(raw);
    return { file, state: normalizeState(state && typeof state === 'object' ? state : {}) };
  } catch (err) {
    if (err?.code === 'ENOENT') return { file, state: {} };
    throw err;
  }
}

function normalizeState(state) {
  if (state.model && !state.ccModel) state.ccModel = state.model;
  if (state.effort && !state.ccEffort) state.ccEffort = state.effort;
  if (state.permMode && !state.permissionMode) state.permissionMode = state.permMode;
  return state;
}

export async function saveState(state, env = process.env) {
  const file = statePath(env);
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  return file;
}

// Polling and background turns can update the same profile concurrently.
// Serialize the entire read/modify/write transaction, not just the rename.
const stateUpdates = globalThis[Symbol.for('msb.stateUpdates')] ||= new Map();
// A serialized snapshot/no-op may opt out of rewriting an otherwise unchanged profile.
export const NO_STATE_WRITE = Symbol('NO_STATE_WRITE');
export function updateState(mutator, env = process.env) {
  const file = statePath(env);
  const previous = stateUpdates.get(file) || Promise.resolve();
  const update = previous.catch(() => {}).then(async () => {
    const { state } = await loadState(env);
    const changed = await mutator({ ...state });
    if (changed === NO_STATE_WRITE) return state;
    const next = changed || state;
    await saveState(next, env);
    return next;
  });
  stateUpdates.set(file, update);
  const release = () => { if (stateUpdates.get(file) === update) stateUpdates.delete(file); };
  update.then(release, release);
  return update;
}

export function hasClaudeAuth(env = process.env, state = {}) {
  if (state.extAuthBypass) return true;
  if (state.authMode === 'subscription' && state.hasSubscriptionAuth) return true;
  return !!(
    env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
    env.MSB_ANTHROPIC_API_KEY?.trim() ||
    env.ANTHROPIC_API_KEY?.trim()
  );
}

export function resolveModel(state = {}) {
  const raw = state.ccModel || state.model || 'opus';
  if (raw === 'opus' || raw === 'opusplan') return 'claude-opus-4-6';
  if (raw === 'sonnet') return 'claude-sonnet-4-6';
  if (raw === 'haiku') return 'claude-haiku-4-5-20251001';
  if (raw === 'fable') return 'claude-fable-5';
  return raw;
}

export function resolveEffort(state = {}) {
  const e = state.ccEffort || state.effort;
  if (!e || e === 'off') return undefined;
  return e;
}

/** UI permissionMode → Claude CLI --permission-mode (CONTRACT-agent-cc). */
export function resolvePermMode(state = {}) {
  const ui = state.permissionMode || state.permMode || 'auto';
  if (ui === 'smart') return 'auto';
  if (ui === 'bypassPermissions' || ui === 'bypass') return 'bypassPermissions';
  if (ui === 'dontAsk') return 'dontAsk';
  // plan / control / auto / default → acceptEdits в штатном бандле
  if (ui === 'plan' || ui === 'control' || ui === 'auto' || ui === 'default' || ui === 'acceptEdits') {
    return 'acceptEdits';
  }
  return 'acceptEdits';
}
