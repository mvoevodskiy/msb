/**
 * Native Cursor CLI login (browser URL, без API-ключа в Telegram).
 * CLI: `NO_OPEN_BROWSER=1 agent login`; статус — `agent status`.
 * Credentials: ~/.config/cursor/auth.json (токены не читаем в ответы).
 * Вызывающий: [native-login](./integration/native-login.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBin } from './adapters/run-cli.mjs';
import { enrichPath } from './ensure-cli.mjs';
import { extractDeviceLoginInfo } from './device-login-parse.mjs';

function cursorBin(env) {
  return findBin('agent', env) || findBin('cursor-agent', env);
}

function authJsonPath(home = os.homedir()) {
  return path.join(home, '.config', 'cursor', 'auth.json');
}

/** Presence-only: есть access/refresh token, значения наружу не отдаём. */
export async function hasNativeCursorAuth(home = os.homedir()) {
  try {
    const raw = await fs.readFile(authJsonPath(home), 'utf8');
    const data = JSON.parse(raw);
    return Boolean(
      data && typeof data === 'object'
      && (typeof data.accessToken === 'string' && data.accessToken.trim()
        || typeof data.refreshToken === 'string' && data.refreshToken.trim()),
    );
  } catch {
    return false;
  }
}

export async function cursorLoginStatus(env = process.env, home = env.HOME || os.homedir()) {
  const childEnv = { ...env, HOME: home, PATH: enrichPath(env, home) };
  const bin = cursorBin(childEnv);
  if (!bin) return { ok: false, error: 'Cursor CLI ещё не установлен' };
  const res = await new Promise((resolve) => {
    const child = spawn(bin, ['status'], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 12_000);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, out: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
  const text = (res.out || '').trim();
  const loggedIn = /logged in/i.test(text) && !/not logged/i.test(text);
  if (res.code === 0 && loggedIn) {
    return { ok: true, mode: 'cli-status', detail: text.slice(0, 120) };
  }
  if (await hasNativeCursorAuth(home)) {
    return { ok: true, mode: 'auth-file', detail: 'cursor auth.json' };
  }
  return { ok: false, error: text.slice(0, 200) || 'Cursor не авторизован' };
}

/**
 * Headless browser login: печатает URL, браузер на сервере не открывает.
 */
export function startCursorBrowserLogin(env = process.env, home = env.HOME || os.homedir()) {
  const childEnv = {
    ...env,
    HOME: home,
    PATH: enrichPath(env, home),
    NO_OPEN_BROWSER: '1',
    BROWSER: 'echo',
  };
  const bin = cursorBin(childEnv);
  if (!bin) {
    return {
      ok: false,
      error: 'Cursor CLI ещё не установлен',
      promise: Promise.resolve({ ok: false, error: 'Cursor CLI ещё не установлен' }),
    };
  }

  let stdout = '';
  let stderr = '';
  const child = spawn(bin, ['login'], {
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
      if (code === 0 && (await hasNativeCursorAuth(home) || (await cursorLoginStatus(childEnv, home)).ok)) {
        resolve({ ok: true, mode: 'browser-login', ...info });
        return;
      }
      resolve({
        ok: false,
        error: (info.text || `agent login exited ${code}`).slice(-400),
        ...info,
      });
    });
  });

  return { ok: true, child, extract, promise };
}

export async function waitCursorNativeAuth({
  env = process.env,
  home = env.HOME || os.homedir(),
  timeoutMs = 300_000,
  pollMs = 2_000,
} = {}) {
  const loginEnv = { ...env, HOME: home };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await hasNativeCursorAuth(home)) {
      const status = await cursorLoginStatus(loginEnv, home);
      if (status.ok) return status;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, error: 'таймаут ожидания входа Cursor' };
}
