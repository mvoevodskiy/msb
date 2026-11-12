/**
 * Локальные CLI-конфиги и штатный device login Codex без передачи токенов в чат.
 * Вход: вывод CLI и выбранный профиль; выход: URL/код и подтверждённый статус.
 * Вызывающий: [native login](./integration/native-login.mjs); проверка:
 * [device login](./tests/codex-device-login.test.mjs), [auth](./tests/auth-wire.test.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { findBin } from './adapters/run-cli.mjs';
import { enrichPath } from './ensure-cli.mjs';
import { hasNativeCodexAuth, selectedCodexProfileDir } from './codex-native.mjs';
import { resolveCodexProfileDir } from '../shared/codex-profile.mjs';

function qwenBaseUrl(key) {
  const k = key.trim();
  // Token Plan personal/team
  if (k.startsWith('sk-sp-')) {
    return 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1';
  }
  // Coding Plan
  if (k.startsWith('sk-') && process.env.MSB_QWEN_CODING_PLAN === '1') {
    return 'https://coding-intl.dashscope.aliyuncs.com/v1';
  }
  // Default: DashScope international compatible
  return (
    process.env.MSB_QWEN_BASE_URL ||
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
  );
}

export async function wireQwenAuth(apiKey, home = os.homedir()) {
  const dir = path.join(home, '.qwen');
  await fs.mkdir(dir, { recursive: true });
  const baseUrl = qwenBaseUrl(apiKey);
  const settings = {
    modelProviders: {
      openai: [
        {
          id: 'qwen3-coder-plus',
          name: 'qwen3-coder-plus',
          baseUrl,
          description: 'Qwen via MSB ext menu',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ],
    },
    security: { auth: { selectedType: 'openai' } },
    model: { name: 'qwen3-coder-plus' },
  };
  const settingsPath = path.join(dir, 'settings.json');
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

  const envFile = path.join(dir, '.env');
  await fs.writeFile(
    envFile,
    `DASHSCOPE_API_KEY=${apiKey}\nOPENAI_API_KEY=${apiKey}\nOPENAI_BASE_URL=${baseUrl}\n`,
    { mode: 0o600 },
  );
  return { settingsPath, baseUrl };
}

function pipeLogin(bin, args, secret, env) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        error: code === 0 ? null : (stderr || stdout).slice(-400),
      });
    });
    child.stdin.end(secret);
  });
}

/** Pin a relative CODEX_HOME to the same project used by normal Codex turns. */
export async function captureCodexLogin(env = process.env, home = env.HOME || os.homedir()) {
  const childEnv = { ...env, HOME: home };
  const profileDir = await selectedCodexProfileDir(childEnv, home);
  if (childEnv.CODEX_HOME) childEnv.CODEX_HOME = profileDir;
  return { env: childEnv, home, profileDir };
}

export async function wireCodexAuth({ accessToken, apiKey }, env = process.env, home = env.HOME || os.homedir()) {
  let target;
  try {
    target = await captureCodexLogin(env, home);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const childEnv = { ...target.env, PATH: enrichPath(target.env, home) };
  const bin = findBin('codex', childEnv);
  if (!bin) return { ok: false, error: 'codex CLI ещё не установлен' };

  if (accessToken) {
    childEnv.CODEX_ACCESS_TOKEN = accessToken;
    const r = await pipeLogin(bin, ['login', '--with-access-token'], accessToken, childEnv);
    if (!r.ok) return { ok: false, error: r.error || 'codex login --with-access-token failed' };
    return { ok: true, mode: 'access-token' };
  }
  if (apiKey) {
    childEnv.OPENAI_API_KEY = apiKey;
    const r = await pipeLogin(bin, ['login', '--with-api-key'], apiKey, childEnv);
    if (!r.ok) return { ok: false, error: r.error || 'codex login --with-api-key failed' };
    return { ok: true, mode: 'api-key' };
  }
  return { ok: false, error: 'нет ключа' };
}

/**
 * Проверка штатного входа в [зафиксированном профиле](./integration/native-login.mjs).
 * Не читает и не возвращает значения секретов.
 */
export async function codexLoginStatus(env = process.env, home = env.HOME || os.homedir()) {
  const childEnv = { ...env, HOME: home, PATH: enrichPath(env, home) };
  const bin = findBin('codex', childEnv);
  if (!bin) return { ok: false, error: 'codex CLI ещё не установлен' };
  const res = await new Promise((resolve) => {
    const child = spawn(bin, ['login', 'status'], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      out += c;
    });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, out: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
  const text = (res.out || '').trim();
  const loggedIn = /logged in/i.test(text) && !/not logged|logged out/i.test(text);
  const apiKeyConfigured = /^API key configured(?: - [^\r\n]+)?\r?$/m.test(text);
  if (res.code === 0 && (loggedIn || apiKeyConfigured)) {
    return { ok: true, mode: 'cli-status', detail: apiKeyConfigured ? 'API key configured' : text.slice(0, 120) };
  }
  return { ok: false, error: text.slice(0, 200) || 'Codex не авторизован' };
}

/**
 * Headless ChatGPT login через device code.
 * Возвращает URL/код для Telegram; не копирует токены в .env.
 */
export function startCodexDeviceLogin(env = process.env, home = env.HOME || os.homedir()) {
  const childEnv = { ...env, HOME: home, PATH: enrichPath(env, home) };
  const profileDir = resolveCodexProfileDir(undefined, childEnv, home);
  const bin = findBin('codex', childEnv);
  if (!bin) {
    return {
      ok: false,
      error: 'codex CLI ещё не установлен',
      promise: Promise.resolve({ ok: false, error: 'codex CLI ещё не установлен' }),
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
  child.stdout.on('data', (c) => {
    stdout += c;
  });
  child.stderr.on('data', (c) => {
    stderr += c;
  });

  const extract = () => {
    // CLI output can contain terminal colours and arrive in several chunks.
    // Parse each stream separately so a synthetic separator never completes
    // a device code whose final character has not arrived yet.
    const streams = [stdout, stderr].map(stripVTControlCharacters);
    const text = streams.join('\n');
    const url = streams.map((stream) =>
      stream.match(/https?:\/\/[^\s]+(?=\s)/i)?.[0]?.replace(/[),.;]+$/, '')
    ).find(Boolean) || null;
    const dashed = streams.map((stream) =>
      stream.match(/\b([A-Z0-9]{4,}-[A-Z0-9-]{4,})(?=[\s),.;!])/)
    ).find(Boolean)?.[1];
    const labelled = streams.flatMap((stream) =>
      Array.from(stream.matchAll(/\bcode[:\s]+([a-z0-9-]{4,})(?=[\s),.;!])/gi), (match) => match[1])
    ).find((value) => /^[A-Z0-9-]+$/.test(value));
    const code = dashed || labelled || null;
    return { url, code, text };
  };

  const promise = new Promise((resolve) => {
    child.on('error', (err) => resolve({ ok: false, error: err.message, ...extract() }));
    child.on('close', async (code) => {
      const info = extract();
      if (code === 0 && (await hasNativeCodexAuth(home, profileDir))) {
        resolve({ ok: true, mode: 'device-auth', ...info });
        return;
      }
      resolve({
        ok: false,
        error: (info.text || `codex login exited ${code}`).slice(-400),
        ...info,
      });
    });
  });

  return { ok: true, child, extract, promise };
}

export async function waitCodexNativeAuth({
  env = process.env,
  home = env.HOME || os.homedir(),
  timeoutMs = 300_000,
  pollMs = 2_000,
} = {}) {
  const loginEnv = { ...env, HOME: home };
  const profileDir = resolveCodexProfileDir(undefined, loginEnv, home);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await hasNativeCodexAuth(home, profileDir)) {
      const status = await codexLoginStatus(loginEnv, home);
      if (status.ok) return status;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, error: 'таймаут ожидания входа Codex' };
}

export async function wireProviderAuth(providerId, secret, env = process.env, home = os.homedir()) {
  if (providerId === 'qwen') {
    const w = await wireQwenAuth(secret, home);
    return { ok: true, detail: `Qwen settings → ${w.baseUrl}` };
  }
  if (providerId === 'codex') {
    // Секреты в Telegram для Codex не принимаем как основной путь.
    // Если всё же передали ключ (ручной/тестовый) — login обязан быть успешным.
    const looksAccess = secret.length > 40 && !secret.startsWith('sk-');
    return wireCodexAuth(
      looksAccess ? { accessToken: secret } : { apiKey: secret },
      env,
      home,
    );
  }
  if (providerId === 'cursor') {
    return { ok: true, detail: 'CURSOR_API_KEY' };
  }
  return { ok: true };
}
