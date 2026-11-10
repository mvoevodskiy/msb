/**
 * Авторизация и аргументы Codex CLI. Профиль хода выбирает [launcher](./codex-auth-env.mjs),
 * prefs читает [shared resolver](../shared/codex-profile.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCodexProfileConfig } from '../shared/codex-profile.mjs';
export { parseCodexTomlScalars } from '../shared/codex-profile.mjs';

export const CODEX_CLI_VERSION = '0.166.0';
export const CODEX_NPM_SPEC = `@openai/codex@${CODEX_CLI_VERSION}`;

const CLAUDE_MODEL_RE =
  /^(claude|anthropic|haiku|sonnet|opus|sonnet-|opus-|haiku-)/i;

export function codexHome(home = os.homedir()) {
  return path.join(home, '.codex');
}

export function codexAuthPath(home = os.homedir(), directory = codexHome(home)) {
  return path.join(directory, 'auth.json');
}

/** Не логировать и не возвращать значения секретов. */
export async function hasNativeCodexAuth(home = os.homedir(), directory = codexHome(home)) {
  try {
    const raw = await fs.readFile(codexAuthPath(home, directory), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return false;
    if (typeof data.OPENAI_API_KEY === 'string' && data.OPENAI_API_KEY.trim()) return true;
    const tokens = data.tokens;
    if (tokens && typeof tokens === 'object') {
      if (tokens.access_token || tokens.refresh_token || tokens.id_token) return true;
    }
    if (data.auth_mode === 'chatgpt' || data.auth_mode === 'api_key' || data.auth_mode === 'AccessToken') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function readCodexNativeConfig(home = os.homedir(), directory = codexHome(home)) {
  return readCodexProfileConfig(directory);
}

export function isClaudeModelAlias(model) {
  if (!model || typeof model !== 'string') return false;
  return CLAUDE_MODEL_RE.test(model.trim());
}

/**
 * Модель для Codex.
 * Приоритет: выбранная в меню (preferred) → явный OpenAI id из argv → native config.toml.
 * Claude-алиасы бандла отбрасываем.
 */
export function resolveCodexModel(parsedModel, nativeConfig, preferred = null) {
  const fromPreferred = typeof preferred === 'string' ? preferred.trim() : '';
  if (fromPreferred && !isClaudeModelAlias(fromPreferred)) return fromPreferred;
  const fromParsed = typeof parsedModel === 'string' ? parsedModel.trim() : '';
  if (fromParsed && !isClaudeModelAlias(fromParsed)) return fromParsed;
  const fromNative = typeof nativeConfig?.model === 'string' ? nativeConfig.model.trim() : '';
  return fromNative || null;
}

export function resolveCodexEffort(nativeConfig) {
  const v = typeof nativeConfig?.modelReasoningEffort === 'string'
    ? nativeConfig.modelReasoningEffort.trim()
    : '';
  return v || null;
}

/** Служебные id, которые shim пишет в stream при ошибке — бандл потом шлёт их в --resume. */
const SENTINEL_SESSION_RE = /^(norestart(-[a-z0-9]+)?|failed|error|unknown)$/i;

export function isCodexSessionSentinel(id) {
  if (typeof id !== 'string') return false;
  return SENTINEL_SESSION_RE.test(id.trim());
}

export function isValidCodexThreadId(id) {
  if (typeof id !== 'string') return false;
  const s = id.trim();
  if (s.length < 8) return false;
  if (isCodexSessionSentinel(s)) return false;
  // Фиктивные timestamp / base36 id из старого shim
  if (/^[cxq]\d{10,}$/i.test(s)) return false;
  if (/^[a-z0-9]{6,12}$/i.test(s) && !s.includes('-')) return false;
  return true;
}
