/**
 * Каталог моделей по CLI-провайдеру + чтение живого списка, где возможно.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getProvider } from './providers.mjs';
import { findBin } from './adapters/run-cli.mjs';
import { enrichPath } from './ensure-cli.mjs';

/** Кураторский список — если CLI/кэш недоступны. */
export const PROVIDER_MODELS = Object.freeze({
  claude: [
    { id: 'opus', label: 'Opus', desc: 'флагман Anthropic' },
    { id: 'sonnet', label: 'Sonnet', desc: 'баланс скорости и качества' },
    { id: 'haiku', label: 'Haiku', desc: 'быстрые ответы' },
    { id: 'fable', label: 'Fable', desc: 'линия Fable' },
  ],
  codex: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', desc: 'актуальный флагман Codex / ChatGPT' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', desc: 'быстрее и дешевле' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', desc: 'кодовая линия 5.3' },
    { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', desc: 'кодовая линия 5.2' },
    { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', desc: 'кодовая линия 5.1' },
    { id: 'o3', label: 'o3', desc: 'глубокое рассуждение' },
  ],
  cursor: [
    { id: 'auto', label: 'Auto', desc: 'роутер Cursor' },
    { id: 'composer-2', label: 'Composer 2', desc: 'быстрая модель Cursor' },
    { id: 'grok-4.7', label: 'Grok 4.7', desc: 'флагман Cursor' },
    { id: 'claude-4.6-opus', label: 'Claude Opus', desc: 'через Cursor' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', desc: 'через Cursor' },
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', desc: 'через Cursor' },
  ],
  qwen: [
    { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', desc: 'основная coding-модель' },
    { id: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash', desc: 'быстрее' },
    { id: 'qwen3.5-plus', label: 'Qwen3.5 Plus', desc: 'общая линия' },
  ],
});

function uniqById(list) {
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

async function readCodexModelsCache(profileDir) {
  try {
    const raw = await fs.readFile(path.join(profileDir, 'models_cache.json'), 'utf8');
    const data = JSON.parse(raw);
    const models = Array.isArray(data?.models) ? data.models : [];
    return models
      .map((m) => ({
        id: String(m.slug || m.id || '').trim(),
        label: String(m.display_name || m.slug || m.id || '').trim(),
        desc: String(m.description || '').trim().slice(0, 80),
      }))
      .filter((m) => m.id && !m.id.includes('auto-review') && !m.id.includes('reserve'));
  } catch {
    return [];
  }
}

function runCapture(bin, args, env, timeoutMs = 12_000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
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
      out += c;
    });
    child.stderr.on('data', (c) => {
      out += c;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

function parseCursorModels(text) {
  const out = [];
  for (const line of String(text || '').split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('Available') || t.startsWith('Model')) continue;
    // formats: "composer-2  Composer 2" or just id
    const m = /^([a-z0-9][a-z0-9._:-]*)(?:\s{2,}|\s+—\s+|\s+-\s+)(.+)$/i.exec(t);
    if (m) {
      out.push({ id: m[1], label: m[2].trim(), desc: '' });
      continue;
    }
    if (/^[a-z0-9][a-z0-9._:-]*$/i.test(t) && t.length < 64) {
      out.push({ id: t, label: t, desc: '' });
    }
  }
  return out;
}

async function listCursorModelsLive(env = process.env, home = os.homedir()) {
  const childEnv = { ...env, PATH: enrichPath(env, home) };
  const bin = findBin('agent', childEnv) || findBin('cursor-agent', childEnv);
  if (!bin) return [];
  const text =
    (await runCapture(bin, ['models'], childEnv)) ||
    (await runCapture(bin, ['--list-models'], childEnv));
  return parseCursorModels(text);
}

/**
 * @returns {Promise<Array<{id:string,label:string,desc?:string}>>}
 */
export async function listModelsForProvider(providerId, env = process.env, home = os.homedir(), profileDir) {
  const base = [...(PROVIDER_MODELS[providerId] || [])];
  if (providerId === 'codex') {
    const cached = profileDir ? await readCodexModelsCache(profileDir) : [];
    return uniqById([...base, ...cached]);
  }
  if (providerId === 'cursor') {
    const live = await listCursorModelsLive(env, home);
    return uniqById(live.length ? live : base);
  }
  return uniqById(base);
}

export function resolveDisplayedModel(providerId, storedId, nativeModel) {
  return storedId || nativeModel || PROVIDER_MODELS[providerId]?.[0]?.id || null;
}

export function modelLabel(providerId, modelId) {
  const hit = (PROVIDER_MODELS[providerId] || []).find((m) => m.id === modelId);
  return hit?.label || modelId || '—';
}

export function providerTitle(providerId) {
  const p = getProvider(providerId);
  return p ? `${p.icon} ${p.title}` : providerId;
}
