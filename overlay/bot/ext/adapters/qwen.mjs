import { findBin, runCli } from './run-cli.mjs';
import { readEnvKey } from '../env.mjs';
import { decodeExtSession, getSelectedModel } from '../store.mjs';
import { enrichPath, ensureProviderCli } from '../ensure-cli.mjs';
import { wireQwenAuth } from '../auth-wire.mjs';
import { isClaudeModelAlias, isCodexSessionSentinel } from '../codex-native.mjs';

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function isBadQwenResume(id) {
  if (!id || typeof id !== 'string') return true;
  if (isCodexSessionSentinel(id)) return true;
  if (/^[cxq]\d{10,}$/i.test(id)) return true;
  if (id === 'norestart' || id.startsWith('norestart-')) return true;
  return false;
}

export async function runQwenTurn({ prompt, parsed, cwd, env }) {
  const envPath = { ...env, PATH: enrichPath(env) };
  let bin = findBin('qwen', envPath);
  if (!bin) {
    const ensured = await ensureProviderCli('qwen', { env: envPath });
    if (!ensured.ok) return { ok: false, text: ensured.error || 'Qwen CLI не установлен' };
    bin = ensured.bin;
  }
  const key =
    (await readEnvKey('QWEN_API_KEY', env)) ||
    (await readEnvKey('DASHSCOPE_API_KEY', env));
  if (!key) return { ok: false, text: 'Нет QWEN_API_KEY. Добавь ключ в «🔌 Подключение».' };

  try {
    await wireQwenAuth(key);
  } catch (err) {
    console.error('[msb/ext/qwen] wire settings failed:', err.message);
  }

  const preferred = await getSelectedModel('qwen', env);
  const fromParsed =
    parsed?.model && !isClaudeModelAlias(parsed.model) ? String(parsed.model).trim() : '';
  const model = preferred || fromParsed || null;

  const childEnv = {
    ...envPath,
    QWEN_API_KEY: key,
    DASHSCOPE_API_KEY: env.DASHSCOPE_API_KEY || key,
    OPENAI_API_KEY: env.OPENAI_API_KEY || key,
  };

  // Длинный prompt через argv может упереться в ARG_MAX — для больших кладём в stdin, если CLI так умеет.
  // Qwen `-p` принимает строку; при очень длинном контексте режем риск через stdin не поддерживается
  // стабильно, поэтому оставляем -p, но не resume'им мусорные id.
  const args = ['-p', prompt, '--yolo', '--approval-mode', 'yolo', '--output-format', 'text'];
  const decoded = parsed.resume ? decodeExtSession(parsed.resume) : null;
  if (decoded?.providerId === 'qwen' && decoded.nativeId && !isBadQwenResume(decoded.nativeId)) {
    args.push('--resume', decoded.nativeId);
  } else if (parsed?.resume && decoded?.providerId === 'qwen') {
    console.error(`[msb/ext/qwen] drop bad resume id (${decoded.nativeId}) → new session`);
  }
  if (model) args.push('--model', model);

  const res = await runCli(bin, args, { cwd, env: childEnv, forwardStderr: false });
  const text = (res.stdout || '').trim();
  const errTail = stripAnsi(res.stderr || '').trim().split(/\n/).filter(Boolean).slice(-4).join(' | ');

  if (res.timedOut) {
    return {
      ok: false,
      text: `Qwen: таймаут${text ? `\n\nЧерновик:\n${text}` : ''}${errTail ? `\n${errTail.slice(0, 300)}` : ''}`,
      model: model || undefined,
    };
  }
  if (res.code !== 0 && !text) {
    return {
      ok: false,
      text: `Qwen завершился с кодом ${res.code}${errTail ? `: ${errTail.slice(0, 400)}` : ''}`,
      model: model || undefined,
    };
  }
  return {
    ok: res.code === 0,
    text: text || '(пустой ответ Qwen)',
    nativeSessionId:
      decoded?.providerId === 'qwen' && decoded.nativeId && !isBadQwenResume(decoded.nativeId)
        ? decoded.nativeId
        : null,
    model: model || undefined,
  };
}
