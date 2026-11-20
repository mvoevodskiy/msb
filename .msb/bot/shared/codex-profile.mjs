/**
 * The CLI cwd and CODEX_HOME choose the native profile. A relative path follows
 * the validated project for [status](../src/agent/display.mjs) and the
 * [Telegram menu](../../../overlay/bot/ext/menu.mjs). The launcher supplies its
 * captured cwd. This module only resolves paths and reads root preferences.
 * [Checks](../../../overlay/bot/ext/tests/codex-profile-preferences.test.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectCwd } from './project-paths.mjs';

export function resolveCodexProfileDir(cwd = process.cwd(), env = process.env, home = env.HOME || os.homedir()) {
  return path.resolve(cwd, env.CODEX_HOME || path.join(home, '.codex'));
}

export async function resolveSelectedCodexProfileDir(state, env = process.env, home = env.HOME || os.homedir()) {
  const relative = env.CODEX_HOME && !path.isAbsolute(env.CODEX_HOME);
  const cwd = relative ? await resolveProjectCwd(state, env) : process.cwd();
  return resolveCodexProfileDir(cwd, env, home);
}

/** Single-line scalars at the root of config.toml. Quoted # remains literal. */
export function parseCodexTomlScalars(text) {
  const scalars = {};
  for (const line of String(text || '').split('\n')) {
    const root = line.trim();
    if (root.startsWith('[')) break;
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(root);
    if (!match) continue;
    const [, key, value] = match;
    const basic = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(value);
    const literal = /^'([^']*)'\s*(?:#.*)?$/.exec(value);
    if (basic) {
      try { scalars[key] = JSON.parse(basic[1]); } catch { /* Unsupported escape. */ }
    } else if (literal) {
      scalars[key] = literal[1];
    } else if (!/^["']/.test(value)) {
      scalars[key] = value.split('#', 1)[0].trim();
    }
  }
  return scalars;
}

export async function readCodexProfileConfig(directory) {
  const text = await fs.readFile(path.join(directory, 'config.toml'), 'utf8').catch(error => {
    if (error?.code !== 'ENOENT') throw error;
    return '';
  });
  const scalars = parseCodexTomlScalars(text);
  return {
    model: scalars.model || null,
    modelReasoningEffort: scalars.model_reasoning_effort || null,
    approvalPolicy: scalars.approval_policy || null,
    sandboxMode: scalars.sandbox_mode || null,
  };
}
