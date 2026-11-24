/**
 * Native Grok Build login (device code, без API-ключа в Telegram).
 * CLI: `grok login --device-auth`; session — ~/.grok/auth.json (значения не читаем в ответы).
 * Вызывающий: [native-login](./integration/native-login.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBin } from './adapters/run-cli.mjs';
import { enrichPath } from './ensure-cli.mjs';
import { extractDeviceLoginInfo } from './device-login-parse.mjs';

function grokHome(env = process.env, home = env.HOME || os.homedir()) {
  return env.GROK_HOME || path.join(home, '.grok');
}

function authJsonPath(env, home) {
  return path.join(grokHome(env, home), 'auth.json');
}

function grokBin(env) {
  return findBin('grok', env) || findBin('grok-build', env);
}

/** Presence-only: есть OAuth session entry с key, токены наружу не отдаём. */
export async function hasNativeGrokAuth(env = process.env, home = env.HOME || os.homedir()) {
  try {
    const raw = await fs.readFile(authJsonPath(env, home), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    return Object.entries(data).some(([scope, entry]) =>
      typeof scope === 'string'
      && scope.includes('auth.x.ai')
      && entry
      && typeof entry === 'object'
      && typeof entry.key === 'string'
      && entry.key.trim());
  } catch {
    return false;
  }
}

/**
 * Сброс локального входа перед повторной авторизацией.
 * `grok logout` + удаление auth.json; значения токенов не читаем в ответы.
 */
export async function clearNativeGrokAuth(env = process.env, home = env.HOME || os.homedir()) {
  const childEnv = { ...env, HOME: home, PATH: enrichPath(env, home) };
  const bin = grokBin(childEnv);
  if (bin) {
    await new Promise((resolve) => {
      const child = spawn(bin, ['logout'], {
        env: childEnv,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        resolve();
      }, 15_000);
      child.on('error', () => { clearTimeout(timer); resolve(); });
      child.on('close', () => { clearTimeout(timer); resolve(); });
    });
  }
  await fs.rm(authJsonPath(childEnv, home), { force: true }).catch(() => {});
  return { ok: !(await hasNativeGrokAuth(childEnv, home)) };
}

export async function grokLoginStatus(env = process.env, home = env.HOME || os.homedir()) {
  const childEnv = { ...env, HOME: home, PATH: enrichPath(env, home) };
  if (!grokBin(childEnv)) return { ok: false, error: 'Grok Build CLI ещё не установлен' };
  if (await hasNativeGrokAuth(childEnv, home)) {
    return { ok: true, mode: 'auth-file', detail: 'grok auth.json' };
  }
  return { ok: false, error: 'Grok Build не авторизован' };
}

export function startGrokDeviceLogin(env = process.env, home = env.HOME || os.homedir()) {
  const childEnv = { ...env, HOME: home, PATH: enrichPath(env, home) };
  const bin = grokBin(childEnv);
  if (!bin) {
    return {
      ok: false,
      error: 'Grok Build CLI ещё не установлен',
      promise: Promise.resolve({ ok: false, error: 'Grok Build CLI ещё не установлен' }),
    };
  }

  let stdout = '';
  let stderr = '';
  const child = spawn(bin, ['login', '--device-auth'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });

  const extract = () => extractDeviceLoginInfo(stdout, stderr);

  const promise = new Promise((resolve) => {
    child.on('error', (err) => resolve({ ok: false, error: err.message, ...extract() }));
    child.on('close', async (code) => {
      const info = extract();
      if (code === 0 && await hasNativeGrokAuth(childEnv, home)) {
        resolve({ ok: true, mode: 'device-auth', ...info });
        return;
      }
      resolve({
        ok: false,
        error: (info.text || `grok login exited ${code}`).slice(-400),
        ...info,
      });
    });
  });

  return { ok: true, child, extract, promise };
}

export async function waitGrokNativeAuth({
  env = process.env,
  home = env.HOME || os.homedir(),
  timeoutMs = 300_000,
  pollMs = 2_000,
} = {}) {
  const loginEnv = { ...env, HOME: home };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await hasNativeGrokAuth(loginEnv, home)) {
      const status = await grokLoginStatus(loginEnv, home);
      if (status.ok) return status;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, error: 'таймаут ожидания входа Grok Build' };
}
