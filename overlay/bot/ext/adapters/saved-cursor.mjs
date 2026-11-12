/**
 * Scheduler-only Cursor invocation for saved prompts. [Core policy](../../../../.msb/bot/src/autonomy/prompt-policy.mjs)
 * admits legacy freshness/shell/continuous/handoff for `extAuthBypass=cursor`.
 * Isolated cwd is `autonomy/cursor-workspace`; continuous resume lives in
 * `autonomy/cursor-sessions.json` by action id. Interactive chat sessions stay separate.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { findBin } from './run-cli.mjs';
import { runOwnedCli } from './owned-cli.mjs';
import { isCursorSessionId, parseCursorJsonOutput } from './cursor.mjs';
import { readEnvKey } from '../env.mjs';
import { getSelectedModel } from '../store.mjs';
import { enrichPath, ensureProviderCli } from '../ensure-cli.mjs';
import { isClaudeModelAlias } from '../codex-native.mjs';

function sessionsFile(cwd) {
  // cwd = autonomy/cursor-workspace → sibling cursor-sessions.json under autonomy/
  return path.join(cwd, '..', 'cursor-sessions.json');
}

async function readSessions(cwd) {
  try {
    const data = JSON.parse(await fs.readFile(sessionsFile(cwd), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeSession(cwd, actionId, sessionId) {
  if (!actionId || !isCursorSessionId(sessionId)) return;
  const file = path.resolve(sessionsFile(cwd));
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const current = await readSessions(cwd);
  current[actionId] = { sessionId: sessionId.trim(), updatedAt: new Date().toISOString() };
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function resolveBin(envPath) {
  let bin = findBin('agent', envPath) || findBin('cursor-agent', envPath);
  if (bin) return bin;
  const ensured = await ensureProviderCli('cursor', { env: envPath });
  return ensured.ok ? ensured.bin : null;
}

export async function savedCursorPromptReady(env = process.env) {
  if (env.JARVIS_CC_ONLY === '1') return false;
  return Boolean(await readEnvKey('CURSOR_API_KEY', env));
}

/**
 * @param {{
 *   prompt: string,
 *   cwd: string,
 *   model?: string,
 *   continuous?: boolean,
 *   actionId?: string,
 *   shell?: boolean,
 *   handoff?: boolean,
 *   signal: AbortSignal,
 *   canLaunch: () => Promise<boolean>,
 *   timeoutMs?: number,
 * }} options
 */
export async function runSavedCursorPrompt(options, env = process.env) {
  const {
    prompt, cwd, model, continuous, actionId, signal, canLaunch, timeoutMs = 1_185_000,
  } = options;
  if (signal.aborted || env.JARVIS_CC_ONLY === '1') return;
  const key = await readEnvKey('CURSOR_API_KEY', env);
  if (!key) {
    return { providerId: 'cursor', text: 'Нет CURSOR_API_KEY для фонового Cursor', assistantTextObserved: true, isError: true };
  }
  if (!await canLaunch()) return;

  const envPath = { ...env, PATH: enrichPath(env), CURSOR_API_KEY: key };
  const bin = await resolveBin(envPath);
  if (!bin || signal.aborted || !await canLaunch()) return;

  let resumeId;
  if (continuous && actionId) {
    const stored = (await readSessions(cwd))[actionId];
    if (stored?.sessionId && isCursorSessionId(stored.sessionId)) resumeId = stored.sessionId.trim();
  }

  const preferred = model || await getSelectedModel('cursor', env);
  const resolvedModel = preferred && !isClaudeModelAlias(preferred) ? String(preferred).trim() : null;

  const args = ['-p', '--force', '--trust', '--sandbox', 'disabled', '--output-format', 'json'];
  if (resolvedModel) args.push('--model', resolvedModel);
  if (resumeId) args.push('--resume', resumeId);
  args.push(prompt);

  const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  if (signal.aborted || !await canLaunch()) return;

  const result = await runOwnedCli(bin, args, { cwd, env: envPath, input: '', signal: turnSignal }).catch(error => {
    if (!signal.aborted) throw error;
    return { aborted: true, stdout: '' };
  });

  const parsedOut = parseCursorJsonOutput(result.stdout);
  let text = '';
  let sessionId = resumeId;
  let usage;
  if (parsedOut) {
    text = String(parsedOut.result ?? parsedOut.text ?? '').trim();
    if (isCursorSessionId(parsedOut.session_id)) sessionId = String(parsedOut.session_id).trim();
    if (parsedOut.usage && typeof parsedOut.usage === 'object') {
      usage = {
        inputTokens: Number(parsedOut.usage.inputTokens || parsedOut.usage.input_tokens) || 0,
        cacheReadTokens: Number(parsedOut.usage.cacheReadTokens || parsedOut.usage.cache_read_input_tokens) || 0,
        cacheCreationTokens: 0,
        outputTokens: Number(parsedOut.usage.outputTokens || parsedOut.usage.output_tokens) || 0,
      };
    }
    if (parsedOut.is_error && !text) {
      text = String(parsedOut.error || parsedOut.result || 'Cursor вернул is_error').trim();
    }
  } else {
    text = String(result.stdout || '').trim();
  }

  if (continuous && resumeId && (result.aborted || result.code !== 0 || (parsedOut && parsedOut.is_error === true))) {
    const reason = text || `код ${result.code ?? 'abort'}`;
    return {
      providerId: 'cursor',
      text: 'не удалось возобновить continuous-сессию Cursor: ' + reason.slice(0, 400),
      assistantTextObserved: true,
      isError: true,
      usage,
    };
  }

  if (continuous && actionId && isCursorSessionId(sessionId) && !result.aborted && result.code === 0) {
    await writeSession(cwd, actionId, sessionId).catch(() => {});
  }

  const isError = Boolean(result.aborted || result.tooLarge) || result.code !== 0 ||
    Boolean(parsedOut && parsedOut.is_error === true);
  return {
    providerId: 'cursor',
    text: text || (isError ? `Cursor agent завершился с кодом ${result.code}` : ''),
    assistantTextObserved: Boolean(text),
    isError,
    usage,
    nativeSessionId: isCursorSessionId(sessionId) ? sessionId : null,
  };
}
