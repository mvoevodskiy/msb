/**
 * Конфиг произвольного OpenAI-compatible endpoint: ключ + base URL + модель.
 * Навигация: [Обвязка](./README.md) → [adapters/openai](./adapters/openai.mjs).
 */
import { readEnvKey, writeEnvKey } from './env.mjs';
import { getSelectedModel, setSelectedModel } from './store.mjs';

export const OPENAI_COMPAT_KEY = 'OPENAI_COMPAT_API_KEY';
export const OPENAI_COMPAT_URL = 'OPENAI_COMPAT_BASE_URL';

/** Нормализует base URL до корня API (без /chat/completions). */
export function normalizeOpenaiBaseUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) throw new Error('URL пустой.');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Некорректный URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL должен быть http(s).');
  }
  let pathName = parsed.pathname.replace(/\/+$/, '') || '';
  if (pathName.endsWith('/chat/completions')) {
    pathName = pathName.slice(0, -'/chat/completions'.length);
  }
  parsed.pathname = pathName || '/';
  parsed.search = '';
  parsed.hash = '';
  // Типичный корень — …/v1; если пользователь дал только origin — оставляем как есть.
  const out = parsed.toString().replace(/\/+$/, '');
  return out;
}

export function chatCompletionsEndpoint(baseUrl) {
  const root = normalizeOpenaiBaseUrl(baseUrl);
  return `${root}/chat/completions`;
}

export async function readOpenaiCompatConfig(env = process.env, home) {
  const apiKey = (await readEnvKey(OPENAI_COMPAT_KEY, env, home)) || '';
  const baseUrl = (await readEnvKey(OPENAI_COMPAT_URL, env, home)) || '';
  const model = (await getSelectedModel('openai', env, home)) || '';
  return { apiKey, baseUrl, model };
}

export async function openaiCompatConfigured(env = process.env, home) {
  const cfg = await readOpenaiCompatConfig(env, home);
  return Boolean(cfg.apiKey && cfg.baseUrl && cfg.model);
}

export async function saveOpenaiCompatConfig({ apiKey, baseUrl, model }, env = process.env, home) {
  const key = String(apiKey || '').trim();
  if (key.length < 8) throw new Error('Ключ слишком короткий.');
  if (/\s/.test(key)) throw new Error('В ключе не должно быть пробелов.');
  const url = normalizeOpenaiBaseUrl(baseUrl);
  const modelId = String(model || '').trim();
  if (!modelId) throw new Error('Имя модели пустое.');
  if (modelId.length > 200) throw new Error('Имя модели слишком длинное.');
  await writeEnvKey(OPENAI_COMPAT_KEY, key, env, home);
  await writeEnvKey(OPENAI_COMPAT_URL, url, env, home);
  await setSelectedModel('openai', modelId, env, home);
  return { apiKey: key, baseUrl: url, model: modelId };
}
