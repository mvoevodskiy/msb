/**
 * Ставит CLI провайдера, если его нет в PATH.
 * Cursor — официальный install-скрипт; Codex/Qwen — npm в ~/.msb/ext-tools (без sudo).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBin } from './adapters/run-cli.mjs';
import { extToolsBin, extToolsPrefix } from './paths.mjs';
import { getProvider } from './providers.mjs';
import { CODEX_NPM_SPEC } from './codex-native.mjs';
import profile from '../shared/profile.cjs';

const MARK = '[msb/ext/ensure-cli]';

function run(command, args, { cwd, env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
      process.stderr.write(c);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(err.message || err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function enrichPath(env = process.env, home = env.HOME || os.homedir()) {
  const extras = [
    extToolsBin(home, env),
    path.join(home, '.local', 'bin'),
    path.join(home, '.cursor', 'bin'),
  ];
  const parts = [...extras, ...(env.PATH || '').split(path.delimiter)].filter(Boolean);
  const seen = new Set();
  const uniq = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    uniq.push(p);
  }
  return uniq.join(path.delimiter);
}

export function cliPresent(providerId, env = process.env) {
  const p = getProvider(providerId);
  if (!p || p.id === 'claude') return { ok: true, bin: profile.envValue(env, 'MSB_REAL_CLAUDE') || 'claude' };
  const names = providerId === 'cursor' ? ['agent', 'cursor-agent'] : [p.bin];
  for (const name of names) {
    const hit = findBin(name, env);
    if (hit) return { ok: true, bin: hit };
  }
  return { ok: false, bin: null };
}

async function ensureNpmPrefix(home, env) {
  const prefix = extToolsPrefix(home, env);
  const bin = extToolsBin(home, env);
  await fs.promises.mkdir(bin, { recursive: true });
  return { prefix, bin };
}

async function installNpmPackage(npmName, binName, env, home) {
  const { prefix } = await ensureNpmPrefix(home, env);
  const childEnv = { ...env, PATH: enrichPath(env, home) };
  console.error(`${MARK} npm i -g --prefix ${prefix} ${npmName}`);
  const res = await run('npm', ['install', '-g', `--prefix`, prefix, npmName], {
    env: childEnv,
    timeoutMs: 900_000,
  });
  if (res.code !== 0) {
    return {
      ok: false,
      error: `npm install ${npmName} failed: ${(res.stderr || res.stdout || '').slice(-500)}`,
    };
  }
  childEnv.PATH = enrichPath(childEnv, home);
  const hit = findBin(binName, childEnv);
  if (!hit) {
    return { ok: false, error: `${binName} не появился в ${extToolsBin(home, env)} после npm install` };
  }
  return { ok: true, bin: hit, installed: true };
}

async function installCursor(env, home) {
  const childEnv = { ...env, PATH: enrichPath(env, home) };
  console.error(`${MARK} installing Cursor CLI via cursor.com/install`);
  const res = await run('bash', ['-lc', 'curl -fsSL https://cursor.com/install | bash'], {
    env: childEnv,
    timeoutMs: 600_000,
  });
  if (res.code !== 0) {
    return {
      ok: false,
      error: `Установка Cursor CLI не удалась: ${(res.stderr || res.stdout || '').slice(-500)}`,
    };
  }
  childEnv.PATH = enrichPath(childEnv, home);
  const hit = findBin('agent', childEnv) || findBin('cursor-agent', childEnv);
  if (!hit) {
    return {
      ok: false,
      error: 'Cursor install завершился, но `agent` не найден в PATH (~/.local/bin).',
    };
  }
  return { ok: true, bin: hit, installed: true };
}

/**
 * @returns {Promise<{ok:boolean, bin?:string, installed?:boolean, skipped?:boolean, error?:string}>}
 */
export async function ensureProviderCli(providerId, { env = process.env, home = env.HOME || os.homedir(), force = false } = {}) {
  if (providerId === 'claude') return { ok: true, skipped: true, bin: profile.envValue(env, 'MSB_REAL_CLAUDE') || 'claude' };

  const envWithPath = { ...env, PATH: enrichPath(env, home) };
  if (!force) {
    const present = cliPresent(providerId, envWithPath);
    if (present.ok) return { ok: true, bin: present.bin, skipped: true };
  }

  if (providerId === 'cursor') return installCursor(envWithPath, home);
  if (providerId === 'codex') return installNpmPackage(CODEX_NPM_SPEC, 'codex', envWithPath, home);
  if (providerId === 'qwen') {
    return installNpmPackage('@qwen-code/qwen-code@latest', 'qwen', envWithPath, home);
  }
  return { ok: false, error: `unknown provider ${providerId}` };
}
