#!/usr/bin/env node
import '../../shared/preload.mjs';
/**
 * Вход PATH-shim claude: штатный Claude либо adapter, возвращающий CLI stream-json ядру.
 * Навигация: [Исполнение CLI](../README.md#исполнение-cli) → [Codex](../adapters/codex.mjs).
 */
import { spawn } from 'node:child_process';
import { resolveNativeClaude } from '../../shared/claude-binary.mjs';
import { loadStore, encodeExtSession, setSession, decodeExtSession } from '../store.mjs';
import { isProviderId } from '../providers.mjs';
import { parseClaudeArgv, readStdin, buildPrompt } from '../adapters/parse-args.mjs';
import { emit, emitInit, emitAssistantText, emitResult, emitError } from '../adapters/stream.mjs';
import { runCursorTurn, isCursorSessionId } from '../adapters/cursor.mjs';
import { runCodexTurn } from '../adapters/codex.mjs';
import { runQwenTurn } from '../adapters/qwen.mjs';
import { isValidCodexThreadId } from '../codex-native.mjs';



function stripForeignResume(argv) {
  // При возврате на Claude чужой ext session id не должен уходить в его CLI.
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--resume') {
      const id = argv[i + 1];
      if (id && decodeExtSession(id)) {
        i += 1;
        continue;
      }
    }
    out.push(argv[i]);
  }
  return out;
}

function passthroughClaude(realBin, argv) {
  const safeArgv = stripForeignResume(argv);
  const isJs = realBin.endsWith('.js') || realBin.endsWith('.mjs') || realBin.endsWith('.cjs');
  const cmd = isJs ? process.execPath : realBin;
  const args = isJs ? [realBin, ...safeArgv] : safeArgv;
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

function acceptNativeSession(providerId, nativeId) {
  if (!nativeId || typeof nativeId !== 'string') return null;
  if (providerId === 'codex') return isValidCodexThreadId(nativeId) ? nativeId : null;
  if (providerId === 'cursor') return isCursorSessionId(nativeId) ? nativeId.trim() : null;
  // Qwen: не сохраняем фиктивные timestamp id / маркеры ошибок
  if (/^[cxq]\d{10,}$/i.test(nativeId)) return null;
  if (nativeId === 'failed' || nativeId === 'error' || nativeId === 'unknown') return null;
  return nativeId;
}

function emitCodexNotice(text, sessionId, model) {
  emitResult({ sessionId, text: '⚠️ ' + text, isError: true, subtype: 'error_notice', model, providerId: 'codex' });
}

async function runAlternate(providerId, argv) {
  const parsed = parseClaudeArgv(argv);
  const userText = await readStdin();
  const prompt = await buildPrompt(parsed, userText, { providerId });
  console.error(`[msb/ext/shim] turn via ${providerId} (prompt=${prompt.length}ch)`);

  const ctx = {
    prompt,
    parsed,
    cwd: process.cwd(),
    env: process.env,
  };

  let result;
  try {
    if (providerId === 'cursor') result = await runCursorTurn(ctx);
    else if (providerId === 'codex') {
      result = await runCodexTurn({
        ...ctx,
        onThreadStarted(id) {
          // Core uses this provisional ID only for the history of a stopped first turn.
          emit({ type: 'system', subtype: 'codex_thread_started',
            provider_id: providerId, session_id: encodeExtSession(providerId, id) });
        },
      });
    } else if (providerId === 'qwen') result = await runQwenTurn(ctx);
    else {
      const fallbackId = encodeExtSession(providerId, 'unknown');
      emitError(`Неизвестный провайдер: ${providerId}`, fallbackId);
      process.exit(1);
      return;
    }
  } catch (err) {
    const msg = err?.code === 'ENOENT'
      ? `CLI провайдера «${providerId}» не найден в PATH`
      : String(err.message || err);
    const fallbackId = encodeExtSession(providerId, 'error');
    if (providerId === 'codex') emitCodexNotice(msg, fallbackId);
    else emitError(msg, fallbackId);
    process.exit(1);
    return;
  }

  let nativeId = acceptNativeSession(providerId, result.nativeSessionId);
  const modelLabel = result.model || `ext/${providerId}`;

  // Сначала отдаём ответ в поток бота; служебное сохранение session не должно его съесть.
  // Важно: не писать session_id вида ext:cursor:failed — бандл делает --resume и CLI падает с кодом 1.
  // Sentinel norestart адаптеры должны игнорировать (новый тред), а не отвечать «повреждённый ID».
  if (!result.ok) {
    if (providerId === 'codex') {
      // An observed partial thread is returned for the ledger. Only a successful turn updates the store.
      const errId = result.partial && nativeId ? encodeExtSession(providerId, nativeId) : parsed.resume || '';
      emitInit({ sessionId: errId, model: modelLabel, providerId });
      if (result.partial) {
        emitResult({ sessionId: errId, text: result.text, isError: true, subtype: 'error_partial',
          usage: result.usage, model: modelLabel, providerId });
      } else if (result.draft) {
        emitResult({ sessionId: errId, text: result.draft.text, isError: true, subtype: 'error_draft',
          errorDisplay: { before: '⚠️ ' + result.draft.before, after: result.draft.after },
          model: modelLabel, providerId });
      } else emitCodexNotice(result.text || 'ход не завершён', errId, modelLabel);
      // Let the stdout pipe drain before exiting with a failed turn.
      process.exitCode = 1;
      return;
    }
    try {
      await setSession(providerId, null);
    } catch {
      /* non-fatal */
    }
    const errId = encodeExtSession(providerId, 'norestart');
    emitInit({ sessionId: errId, model: modelLabel, providerId });
    emitError(result.text || 'ход не завершён', errId, { model: modelLabel });
    process.exit(1);
    return;
  }

  if (!nativeId) {
    // Текст есть, нативный id нет — всё равно отдаём ход; resume на следующем ходе не взлетит.
    nativeId = `norestart-${Date.now().toString(36)}`;
  }

  const finalSession = encodeExtSession(providerId, nativeId);
  emitInit({ sessionId: finalSession, model: modelLabel, providerId });
  emitAssistantText(result.text, finalSession, { model: modelLabel, usage: result.usage, providerId });
  emitResult({
    sessionId: finalSession,
    text: result.text,
    isError: false,
    model: modelLabel,
    usage: result.usage,
    providerId,
  });

  if (!String(nativeId).startsWith('norestart-')) {
    try {
      await setSession(providerId, nativeId);
    } catch (err) {
      console.error('[msb/ext/shim] setSession failed (ответ уже отдан):', err?.message || err);
    }
  }

  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  let active = 'claude';
  const pinned = process.env.MSB_TURN_PROVIDER;
  if (pinned) {
    if (!isProviderId(pinned)) throw new Error('Invalid turn provider');
    if (process.env.JARVIS_CC_ONLY === '1' && pinned !== 'claude') throw new Error('Turn provider conflicts with Claude-only mode');
    active = pinned;
  } else {
    // Compatibility with legacy/direct shim callers that have no turn snapshot.
    try {
      active = (await loadStore()).active || 'claude';
    } catch (err) {
      console.error('[msb/ext/shim] store load failed:', err.message);
    }
  }

  if (active === 'claude' || process.env.JARVIS_CC_ONLY === '1') {
    const real = resolveNativeClaude();
    if (!real) {
      console.error('[msb/ext/shim] настоящий claude не найден (MSB_REAL_CLAUDE / PATH)');
      process.exit(127);
    }
    emit({ type: 'system', subtype: 'provider', provider_id: 'claude' });
    passthroughClaude(real, argv);
    return;
  }

  emit({ type: 'system', subtype: 'provider', provider_id: active });
  await runAlternate(active, argv);
}

main().catch((err) => {
  console.error('[msb/ext/shim] fatal:', err);
  process.exit(1);
});
