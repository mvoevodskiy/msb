/**
 * Grok Build CLI (xAI): headless `--single` + JSON, как Cursor-адаптер для бота.
 * Бинарь `grok`; auth — `XAI_API_KEY`. Установка — [ensure-cli](../ensure-cli.mjs).
 * Диспетчер хода — [shim/run-turn](../shim/run-turn.mjs).
 */
import { findBin, runCli } from './run-cli.mjs';
import { readEnvKey } from '../env.mjs';
import { decodeExtSession, getSelectedModel } from '../store.mjs';
import { enrichPath, ensureProviderCli } from '../ensure-cli.mjs';
import { isClaudeModelAlias } from '../codex-native.mjs';
import { hasNativeGrokAuth } from '../grok-auth.mjs';
import { runGrokAcpTurn } from './grok-acp.mjs';

const sentinel = /^(norestart(?:-[a-z0-9]+)?|failed|error|unknown)$/i;

/** Env для CLI: native session без XAI_API_KEY (ключ — отдельный API-рельс). */
export function applyGrokAuthEnv(childEnv, { key, native } = {}) {
  delete childEnv.XAI_API_KEY;
  if (!native && key) childEnv.XAI_API_KEY = key;
  return childEnv;
}

/** Нативный session id Grok Build (UUID или иной непустой id без sentinel). */
export function isGrokSessionId(id) {
  if (typeof id !== 'string') return false;
  const native = id.trim();
  if (!native || native.length < 4 || native.length > 128) return false;
  if (sentinel.test(native)) return false;
  if (/^[cxq]\d{10,}$/i.test(native)) return false;
  // Не принимать уже закодированный ext:… и мусор с пробелами/путями.
  if (/[:/\s]/.test(native)) return false;
  return true;
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

/** Разбор `--output-format json`: последний JSON-объект из stdout. */
export function parseGrokJsonOutput(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const data = JSON.parse(lines[i]);
      if (data && typeof data === 'object') return data;
    } catch {
      /* try previous line */
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sessionFromParsed(parsedOut) {
  const raw = parsedOut?.sessionId ?? parsedOut?.session_id;
  return isGrokSessionId(raw) ? String(raw).trim() : null;
}

export async function runGrokTurn({ prompt, parsed, cwd, env, onSteerReady, signal }) {
  const envPath = { ...env, PATH: enrichPath(env) };
  let bin = findBin('grok', envPath) || findBin('grok-build', envPath);
  if (!bin) {
    const ensured = await ensureProviderCli('grok', { env: envPath });
    if (!ensured.ok) {
      return { ok: false, text: ensured.error || 'Grok Build CLI не установлен' };
    }
    bin = ensured.bin;
  }
  const key = await readEnvKey('XAI_API_KEY', env);
  const native = await hasNativeGrokAuth(env);
  if (!key && !native) {
    return {
      ok: false,
      text: 'Нет входа Grok Build. Нажми «🔐 Вход» в «🔌 Подключение» (подписка) или добавь XAI_API_KEY (отдельный API-биллинг).',
    };
  }

  const preferred = await getSelectedModel('grok', env);
  const fromParsed =
    parsed?.model && !isClaudeModelAlias(parsed.model) ? String(parsed.model).trim() : '';
  const model = preferred || fromParsed || null;
  const decoded = parsed.resume ? decodeExtSession(parsed.resume) : null;
  const resumeId =
    decoded?.providerId === 'grok' && isGrokSessionId(decoded.nativeId)
      ? decoded.nativeId.trim()
      : null;
  if (parsed?.resume && decoded?.providerId === 'grok' && !resumeId) {
    console.error(`[msb/ext/grok] drop bad resume id → new chat`);
  }

  const childEnv = applyGrokAuthEnv(
    { ...envPath, GROK_DISABLE_AUTOUPDATER: env.GROK_DISABLE_AUTOUPDATER || '1' },
    { key, native },
  );

  if (typeof onSteerReady === 'function') {
    const raw = await runGrokAcpTurn({
      bin, cwd, childEnv, model, resumeId, prompt, onSteerReady, signal,
    });
    const text = String(raw.parsedOut?.text || '').trim();
    const sessionId = isGrokSessionId(raw.parsedOut?.sessionId) ? raw.parsedOut.sessionId : null;
    if (raw.parsedOut?.turnCompleted) {
      return {
        ok: true,
        text: text || '(пустой ответ Grok Build)',
        nativeSessionId: sessionId,
        model: model || undefined,
      };
    }
    return {
      ok: false,
      text: text
        ? `${raw.parsedOut.turnFailed || 'Grok ACP'}\n\nЧерновик:\n${text}`
        : (raw.parsedOut?.turnFailed || 'Grok ACP turn failed'),
      nativeSessionId: sessionId,
      model: model || undefined,
    };
  }

  // json — чтобы забрать sessionId; plain не отдаёт id → shim писал ext:grok:failed.
  // --single=… держит prompt цельным argv (в т.ч. строки, начинающиеся с «-»).
  const args = [
    '--always-approve',
    '--output-format',
    'json',
    '--no-auto-update',
  ];
  if (model) args.push('--model', model);
  if (resumeId) args.push('--resume', resumeId);
  args.push(`--single=${prompt}`);

  const res = await runCli(bin, args, { cwd, env: childEnv, forwardStderr: false });
  const parsedOut = parseGrokJsonOutput(res.stdout);
  let text = '';
  let sessionId = resumeId;
  let usage;

  if (parsedOut) {
    text = String(parsedOut.text ?? parsedOut.result ?? '').trim();
    const fromOut = sessionFromParsed(parsedOut);
    if (fromOut) sessionId = fromOut;
    if (parsedOut.usage && typeof parsedOut.usage === 'object') {
      usage = {
        input_tokens: Number(parsedOut.usage.inputTokens || parsedOut.usage.input_tokens) || 0,
        output_tokens: Number(parsedOut.usage.outputTokens || parsedOut.usage.output_tokens) || 0,
        cached_input_tokens:
          Number(parsedOut.usage.cacheReadTokens || parsedOut.usage.cached_input_tokens) || 0,
      };
    }
    const stop = String(parsedOut.stopReason || parsedOut.stop_reason || '').trim();
    if ((stop === 'refusal' || stop === 'cancelled') && !text) {
      text = `Grok Build: ${stop}`;
    }
  } else {
    text = (res.stdout || '').trim();
  }

  const errTail = stripAnsi(res.stderr || '').trim().split(/\n/).filter(Boolean).slice(-4).join(' | ');

  if (res.timedOut) {
    return {
      ok: false,
      text: `Grok Build: таймаут${text ? `\n\nЧерновик:\n${text}` : ''}${errTail ? `\n${errTail.slice(0, 300)}` : ''}`,
      model: model || undefined,
    };
  }

  if (res.code !== 0 && !text) {
    return {
      ok: false,
      text: `Grok Build завершился с кодом ${res.code}${errTail ? `: ${errTail.slice(0, 400)}` : ''}`,
      model: model || undefined,
    };
  }

  const stopReason = parsedOut
    ? String(parsedOut.stopReason || parsedOut.stop_reason || '').trim()
    : '';
  const ok = res.code === 0 && stopReason !== 'refusal' && stopReason !== 'cancelled';
  return {
    ok,
    text:
      text ||
      (ok
        ? '(пустой ответ Grok Build)'
        : `Grok Build завершился с кодом ${res.code}${errTail ? `: ${errTail.slice(0, 400)}` : ''}`),
    nativeSessionId: isGrokSessionId(sessionId) ? sessionId : null,
    model: model || undefined,
    usage,
  };
}
