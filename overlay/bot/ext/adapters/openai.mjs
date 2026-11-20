/**
 * Ход через произвольный OpenAI-compatible Chat Completions API.
 * Навигация: [openai-compat](../openai-compat.mjs) → [shim](../shim/run-turn.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { botDir } from '../paths.mjs';
import { decodeExtSession, getSelectedModel } from '../store.mjs';
import {
  chatCompletionsEndpoint,
  readOpenaiCompatConfig,
} from '../openai-compat.mjs';
import { providerRuntimeOverride } from './parse-args.mjs';

const MAX_HISTORY = 40;

function sessionsDir(env, home) {
  return path.join(botDir(env, home), 'openai-sessions');
}

function sessionPath(sessionId, env, home) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safe) throw new Error('bad session id');
  return path.join(sessionsDir(env, home), `${safe}.json`);
}

async function loadHistory(sessionId, env, home) {
  if (!sessionId) return [];
  try {
    const data = JSON.parse(await fs.readFile(sessionPath(sessionId, env, home), 'utf8'));
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function saveHistory(sessionId, messages, env, home) {
  const dir = sessionsDir(env, home);
  await fs.mkdir(dir, { recursive: true });
  const file = sessionPath(sessionId, env, home);
  const trimmed = messages.slice(-MAX_HISTORY);
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify({ messages: trimmed }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function buildSystemPrompt(parsed) {
  const parts = [];
  const override = providerRuntimeOverride('openai');
  if (override) parts.push(override);
  if (parsed?.appendSystemPromptFile) {
    try {
      parts.push(await fs.readFile(parsed.appendSystemPromptFile, 'utf8'));
    } catch (err) {
      parts.push(`[system prompt file unreadable: ${err.message}]`);
    }
  }
  if (parsed?.appendSystemPrompt) parts.push(parsed.appendSystemPrompt);
  return parts.filter(Boolean).join('\n\n---\n\n');
}

function resolveResumeId(parsed) {
  if (!parsed?.resume) return null;
  const decoded = decodeExtSession(parsed.resume);
  if (decoded?.providerId === 'openai' && decoded.nativeId && !String(decoded.nativeId).startsWith('norestart')) {
    return decoded.nativeId;
  }
  return null;
}

export async function runOpenaiTurn({
  prompt,
  parsed,
  env,
  home = os.homedir(),
  userText,
  fetchImpl = globalThis.fetch,
}) {
  const cfg = await readOpenaiCompatConfig(env, home);
  if (!cfg.apiKey || !cfg.baseUrl) {
    return {
      ok: false,
      text: 'Нет настроек OpenAI-compatible. Укажи ключ и URL в «🔌 Подключение».',
    };
  }
  const preferred = await getSelectedModel('openai', env, home);
  const fromParsed = parsed?.model && String(parsed.model).trim() ? String(parsed.model).trim() : '';
  const model = preferred || fromParsed || cfg.model;
  if (!model) {
    return { ok: false, text: 'Не задано имя модели. Укажи его в «🔌 Подключение» или «🧠 Модель».' };
  }

  const resumeId = resolveResumeId(parsed);
  const nativeSessionId = resumeId || randomUUID().replace(/-/g, '').slice(0, 24);
  const history = await loadHistory(nativeSessionId, env, home);
  const system = await buildSystemPrompt(parsed);
  const userContent = (userText != null ? String(userText) : prompt) || '';

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const m of history) {
    if (m?.role && m?.content) messages.push({ role: m.role, content: String(m.content) });
  }
  messages.push({ role: 'user', content: userContent });

  const endpoint = chatCompletionsEndpoint(cfg.baseUrl);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      text: `OpenAI-compatible сеть: ${String(err.message || err).slice(0, 300)}`,
      model,
      nativeSessionId,
    };
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const detail =
      data?.error?.message ||
      data?.message ||
      raw.slice(0, 400) ||
      `HTTP ${response.status}`;
    return {
      ok: false,
      text: `OpenAI-compatible ${response.status}: ${String(detail).slice(0, 400)}`,
      model,
      nativeSessionId,
    };
  }

  const choice = data?.choices?.[0];
  const text =
    choice?.message?.content ||
    choice?.text ||
    (Array.isArray(choice?.message?.content)
      ? choice.message.content.map((c) => c?.text || '').join('')
      : '') ||
    '';

  const nextHistory = [
    ...history,
    { role: 'user', content: userContent },
    { role: 'assistant', content: String(text || '') },
  ];
  try {
    await saveHistory(nativeSessionId, nextHistory, env, home);
  } catch (err) {
    console.error('[msb/ext/openai] session save failed:', err.message);
  }

  const usage = data?.usage
    ? {
        input_tokens: Number(data.usage.prompt_tokens) || 0,
        output_tokens: Number(data.usage.completion_tokens) || 0,
      }
    : undefined;

  return {
    ok: true,
    text: String(text || '').trim() || '(пустой ответ)',
    nativeSessionId,
    model,
    usage,
  };
}
