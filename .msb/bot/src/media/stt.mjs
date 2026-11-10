/**
 * Backend распознавания: env/provider, timeout, abort; возвращает полный transcript.
 * Навигация: [Media](./README.md) ← [Telegram voice](../telegram/voice.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { botRoot, msbRoot } from '../paths.mjs';

const KEYS = ['DEEPGRAM_API_KEY', 'STT_LANGUAGE', 'STT_COMMAND', 'STT_COMMAND_TIMEOUT_MS'];
const LANGUAGE = /^([a-z]{2,3}(-[a-z0-9]{2,4})?|multi)$/;

/** Old voice timeout: 60s + 30s/MiB, capped at 300s; unknown size uses the cap. */
export function audioTimeoutMs(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return 300_000;
  return Math.min(300_000, Math.round(60_000 + bytes / 1_048_576 * 30_000));
}

async function readSettings(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (err) { if (err?.code === 'ENOENT') return new Map(); throw err; }
  const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim());
    if (!match || !KEYS.includes(match[1])) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values;
}

/** Read only STT settings, without importing a shared env into process.env. */
export async function resolveSttConfig(env = process.env) {
  const values = new Map();
  for (const key of KEYS) if (env[key] !== undefined) values.set(key, String(env[key]).trim());
  for (const file of [path.join(botRoot(env), '.env'), path.join(msbRoot(env), '.env')]) {
    if (KEYS.every((key) => values.has(key))) break;
    for (const [key, value] of await readSettings(file)) if (!values.has(key)) values.set(key, value.trim());
  }
  const command = values.get('STT_COMMAND') || '';
  const apiKey = values.get('DEEPGRAM_API_KEY') || '';
  if (!command && !apiKey) {
    const err = new Error('DEEPGRAM_API_KEY не настроен. Добавь в /settings → 🔑');
    err.code = 'STT_NOT_CONFIGURED';
    throw err;
  }
  const language = (values.get('STT_LANGUAGE') || '').toLowerCase();
  const timeout = Number(values.get('STT_COMMAND_TIMEOUT_MS'));
  return {
    provider: command ? 'command' : 'deepgram',
    apiKey, command,
    language: LANGUAGE.test(language) ? language : 'ru',
    commandTimeoutMs: Number.isFinite(timeout) && timeout > 0
      ? Math.min(7_200_000, Math.max(60_000, Math.round(timeout))) : 1_800_000,
  };
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Распознавание остановлено.', 'AbortError');
}

function audioBytes(bytes) {
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('Ожидаются байты голосового сообщения.');
}

function redact(text, secret) {
  return secret ? String(text).split(secret).join('[REDACTED]') : String(text);
}

async function transcribeCommand(bytes, config, env, signal) {
  let directory;
  try {
    checkAbort(signal);
    directory = await fs.mkdtemp(path.join(env.TMPDIR || os.tmpdir(), 'msb-stt-'));
    checkAbort(signal);
    const file = path.join(directory, 'audio.ogg');
    await fs.writeFile(file, bytes, { mode: 0o600 });
    checkAbort(signal);
    const stdout = await new Promise((resolve, reject) => {
      execFile(config.command, [file], {
        shell: false,
        timeout: config.commandTimeoutMs,
        maxBuffer: 33_554_432,
        signal,
        env: { ...env, STT_LANGUAGE: config.language, DEEPGRAM_API_KEY: config.apiKey },
      }, (err, output) => err ? reject(err) : resolve(output));
    });
    checkAbort(signal);
    const transcript = String(stdout ?? '').trim();
    if (!transcript) throw new Error('Команда распознавания вернула пустой текст');
    return transcript;
  } catch (err) {
    checkAbort(signal);
    if (err?.killed || err?.signal === 'SIGTERM' || err?.name === 'TimeoutError') {
      throw new Error(`Команда распознавания не ответила за ${Math.round(config.commandTimeoutMs / 1000)} с`);
    }
    if (typeof err?.code === 'number') throw new Error(`Команда распознавания завершилась с кодом ${err.code}`);
    if (err?.code) throw new Error(`Команда распознавания не запустилась: ${err.code}`);
    throw new Error(redact(err?.message || err, config.apiKey));
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Return the full transcript. Caller cancellation wins over a late HTTP/CLI result. */
export async function transcribeVoice(bytes, { signal, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  checkAbort(signal);
  const config = await resolveSttConfig(env);
  checkAbort(signal);
  const audio = audioBytes(bytes);
  if (config.provider === 'command') return transcribeCommand(audio, config, env, signal);

  const timeout = audioTimeoutMs(audio.byteLength);
  const deadline = AbortSignal.timeout(timeout);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    checkAbort(signal);
    const url = `https://api.deepgram.com/v1/listen?model=nova-3&language=${encodeURIComponent(config.language)}&smart_format=true&punctuate=true`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Token ${config.apiKey}`, 'Content-Type': 'audio/ogg' },
      body: audio,
      signal: requestSignal,
    });
    checkAbort(signal);
    if (!response.ok) {
      const detail = await response.text();
      checkAbort(signal);
      throw new Error(`Deepgram ${response.status}: ${redact(detail, config.apiKey).slice(0, 200)}`);
    }
    const result = await response.json();
    checkAbort(signal);
    const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (typeof transcript !== 'string' || !transcript.trim()) throw new Error('Deepgram: пустой результат');
    return transcript;
  } catch (err) {
    checkAbort(signal);
    if (deadline.aborted || err?.name === 'TimeoutError') throw new Error(`Deepgram не ответил за ${Math.round(timeout / 1000)} с`);
    throw new Error(redact(err?.message || err, config.apiKey));
  }
}
