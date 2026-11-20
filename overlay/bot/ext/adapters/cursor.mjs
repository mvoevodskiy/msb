import { findBin, runCli } from './run-cli.mjs';
import { readEnvKey } from '../env.mjs';
import { decodeExtSession, getSelectedModel } from '../store.mjs';
import { enrichPath, ensureProviderCli } from '../ensure-cli.mjs';
import { isClaudeModelAlias } from '../codex-native.mjs';

/** Нативный chat/session id Cursor CLI (UUID). */
export function isCursorSessionId(id) {
  return typeof id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

/** Разбор `--output-format json`: берём последний JSON-объект из stdout. */
export function parseCursorJsonOutput(stdout) {
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

async function createCursorChat(bin, env, cwd) {
  try {
    const res = await runCli(bin, ['create-chat'], { cwd, env, forwardStderr: false, timeoutMs: 30_000 });
    const id = (res.stdout || '').trim().split(/\s+/)[0];
    return isCursorSessionId(id) ? id : null;
  } catch {
    return null;
  }
}

export async function runCursorTurn({ prompt, parsed, cwd, env }) {
  const envPath = { ...env, PATH: enrichPath(env) };
  let bin = findBin('agent', envPath) || findBin('cursor-agent', envPath);
  if (!bin) {
    const ensured = await ensureProviderCli('cursor', { env: envPath });
    if (!ensured.ok) {
      return { ok: false, text: ensured.error || 'Cursor CLI не установлен' };
    }
    bin = ensured.bin;
  }
  const key = await readEnvKey('CURSOR_API_KEY', env);
  if (!key) return { ok: false, text: 'Нет CURSOR_API_KEY. Добавь ключ в «🔌 Подключение».' };

  const preferred = await getSelectedModel('cursor', env);
  const fromParsed =
    parsed?.model && !isClaudeModelAlias(parsed.model) ? String(parsed.model).trim() : '';
  const model = preferred || fromParsed || null;

  // json — чтобы забрать session_id; text не отдаёт id → shim писал ext:cursor:failed → --resume failed.
  const args = ['-p', '--force', '--trust', '--sandbox', 'disabled', '--output-format', 'json'];
  if (model) args.push('--model', model);
  const decoded = parsed.resume ? decodeExtSession(parsed.resume) : null;
  const resumeId =
    decoded?.providerId === 'cursor' && isCursorSessionId(decoded.nativeId)
      ? decoded.nativeId.trim()
      : null;
  if (resumeId) args.push('--resume', resumeId);
  args.push(prompt);

  const childEnv = { ...envPath, CURSOR_API_KEY: key };
  if (parsed?.resume && decoded?.providerId === 'cursor' && !resumeId) {
    console.error(`[msb/ext/cursor] drop bad resume id → new chat`);
  }
  const res = await runCli(bin, args, { cwd, env: childEnv, forwardStderr: false });
  const parsedOut = parseCursorJsonOutput(res.stdout);
  let text = '';
  let sessionId = resumeId;
  let usage;

  if (parsedOut) {
    text = String(parsedOut.result ?? parsedOut.text ?? '').trim();
    if (isCursorSessionId(parsedOut.session_id)) sessionId = String(parsedOut.session_id).trim();
    if (parsedOut.usage && typeof parsedOut.usage === 'object') {
      usage = {
        input_tokens: Number(parsedOut.usage.inputTokens || parsedOut.usage.input_tokens) || 0,
        output_tokens: Number(parsedOut.usage.outputTokens || parsedOut.usage.output_tokens) || 0,
        cached_input_tokens: Number(parsedOut.usage.cacheReadTokens || parsedOut.usage.cache_read_input_tokens) || 0,
      };
    }
    if (parsedOut.is_error && !text) {
      text = String(parsedOut.error || parsedOut.result || 'Cursor вернул is_error').trim();
    }
  } else {
    text = (res.stdout || '').trim();
  }

  const errTail = stripAnsi(res.stderr || '').trim().split(/\n/).filter(Boolean).slice(-4).join(' | ');

  if (res.timedOut) {
    return {
      ok: false,
      text: `Cursor: таймаут${text ? `\n\nЧерновик:\n${text}` : ''}${errTail ? `\n${errTail.slice(0, 300)}` : ''}`,
      model: model || undefined,
    };
  }

  if (res.code !== 0 && !text) {
    return {
      ok: false,
      text: `Cursor agent завершился с кодом ${res.code}${errTail ? `: ${errTail.slice(0, 400)}` : ''}`,
      model: model || undefined,
    };
  }

  // Без валидного UUID следующий ход снова уйдёт в --resume мусора.
  if (!isCursorSessionId(sessionId) && text) {
    sessionId = await createCursorChat(bin, childEnv, cwd);
  }

  const ok = res.code === 0 && !(parsedOut && parsedOut.is_error === true);
  return {
    ok,
    text: text || (ok ? '(пустой ответ Cursor)' : `Cursor agent завершился с кодом ${res.code}${errTail ? `: ${errTail.slice(0, 400)}` : ''}`),
    nativeSessionId: isCursorSessionId(sessionId) ? sessionId : null,
    model: model || undefined,
    usage,
  };
}
