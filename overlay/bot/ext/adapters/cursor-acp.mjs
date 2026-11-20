/**
 * Cursor ACP turn with mid-turn «Учесть сейчас».
 * Cursor agent has no `turn/steer`; a second `session/prompt` cancels the
 * in-flight turn and starts the correction (send-now). Ack is optimistic on
 * successful write so Telegram steer stays non-blocking like Codex.
 * Ordinary non-steer turns keep [cursor.mjs](./cursor.mjs) `-p` path.
 * RPC framing → [acp-rpc](./acp-rpc.mjs).
 */
import { spawn } from 'node:child_process';
import { isCursorSessionId } from './cursor.mjs';
import { createAcpRpc, acpTextPrompt, allowOncePermission } from './acp-rpc.mjs';

export async function runCursorAcpTurn({
  bin, cwd, childEnv, model, resumeId, prompt, onSteerReady, signal, timeoutMs = 1_800_000,
}) {
  const parsedOut = {
    text: '', sessionId: resumeId || null, usage: null, turnCompleted: false, turnFailed: null,
  };
  let child;
  let rpc;
  let ready = false;
  let terminal = false;
  let sessionId = resumeId || null;
  let activePromptId = null;
  let steeredPromptId = null;
  let finishTimer;
  let terminalResolve;
  const done = new Promise((resolve) => { terminalResolve = resolve; });
  const chunks = [];
  // session/load replays the whole transcript as session/update; only the
  // chunks after the active session/prompt belong in the Telegram reply.
  let collectText = false;

  const beginTurnText = () => {
    chunks.length = 0;
    collectText = true;
  };

  const invalidate = () => {
    if (!ready) return;
    ready = false;
    try { onSteerReady?.(null); } catch { /* */ }
  };

  const finish = (failed = null) => {
    if (terminal) return;
    terminal = true;
    collectText = false;
    invalidate();
    parsedOut.text = chunks.join('').trim();
    if (failed) parsedOut.turnFailed = failed;
    else parsedOut.turnCompleted = true;
    terminalResolve();
  };

  const onAbort = () => finish('Cursor stopped');

  try {
    signal?.throwIfAborted();
    const args = ['acp'];
    child = spawn(bin, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-8192); });

    rpc = createAcpRpc(child, {
      timeoutMs,
      onNotification(msg) {
        if (msg.method !== 'session/update') return;
        const update = msg.params?.update;
        if (!collectText) return;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
          chunks.push(String(update.content.text));
        }
      },
      onServerRequest(msg, respond) {
        if (msg.method === 'session/request_permission') allowOncePermission(respond);
        else if (msg.method?.startsWith('cursor/')) {
          // Blocking Cursor extensions: skip / cancel so the turn can continue.
          respond({ outcome: { outcome: 'cancelled' } });
        } else {
          respond({});
        }
      },
    });

    signal?.addEventListener('abort', onAbort, { once: true });
    finishTimer = setTimeout(() => finish('Cursor timeout'), timeoutMs);

    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'msb_cursor', version: '1' },
    });
    await rpc.request('authenticate', { methodId: 'cursor_login' });

    if (resumeId && isCursorSessionId(resumeId)) {
      try {
        const loaded = await rpc.request('session/load', { sessionId: resumeId, cwd, mcpServers: [] });
        sessionId = loaded?.sessionId || resumeId;
      } catch {
        const created = await rpc.request('session/new', { cwd, mcpServers: [] });
        sessionId = created?.sessionId;
      }
    } else {
      const created = await rpc.request('session/new', { cwd, mcpServers: [] });
      sessionId = created?.sessionId;
    }
    if (!isCursorSessionId(sessionId)) throw Error('Cursor session ID missing');
    parsedOut.sessionId = sessionId;

    const promptParams = {
      sessionId,
      prompt: acpTextPrompt(prompt),
      ...(model ? { _meta: { model } } : {}),
    };
    // Some Cursor builds accept model via session/prompt params.model — keep both soft.
    if (model) promptParams.model = model;

    beginTurnText();
    activePromptId = rpc.notifyRequest('session/prompt', promptParams);
    // Track completion of the active (possibly steered) prompt via takeResult below.

    if (!terminal) {
      ready = true;
      const handle = {
        threadId: sessionId,
        turnId: String(activePromptId),
        invalidate,
        async steer(text) {
          if (!ready || terminal || rpc.closed) return { status: 'rejected' };
          if (typeof text !== 'string' || !text.trim() || text.length > 1_000_000) {
            return { status: 'rejected' };
          }
          try {
            // Send-now: second prompt cancels the in-flight turn (Cursor ACP v1).
            beginTurnText();
            steeredPromptId = rpc.notifyRequest('session/prompt', {
              sessionId,
              prompt: acpTextPrompt(text),
            });
            handle.turnId = String(steeredPromptId);
            return { status: 'accepted' };
          } catch {
            return { status: 'unknown' };
          }
        },
      };
      try { onSteerReady?.(handle); } catch { invalidate(); }
    }

    // Wait until the latest prompt finishes (original or steered).
    const waitPrompt = async (id) => {
      try {
        const result = await rpc.takeResult(id, { waitMs: timeoutMs });
        return result;
      } catch (error) {
        if (error?.timeout) return finish('Cursor timeout');
        if (error?.closed || signal?.aborted) return finish(signal?.aborted ? 'Cursor stopped' : 'Cursor connection lost');
        return finish(error?.message || 'Cursor ACP request failed');
      }
    };

    let result = await waitPrompt(activePromptId);
    if (terminal) { /* finished via timeout/abort */ }
    else if (steeredPromptId != null) {
      // Original cancelled; steer already reset text via beginTurnText().
      result = await waitPrompt(steeredPromptId);
      if (!terminal) {
        if (result?.stopReason === 'end_turn' || result?.stopReason === 'cancelled') {
          // cancelled here would mean a further replacement; treat end_turn as success.
          finish(result?.stopReason === 'end_turn' ? null : 'Cursor turn cancelled');
        } else {
          finish(result?.stopReason ? `Cursor ${result.stopReason}` : null);
        }
      }
    } else if (result?.stopReason === 'end_turn') {
      finish(null);
    } else if (result?.stopReason === 'cancelled') {
      // Steered after response arrived; wait if steer id set concurrently.
      if (steeredPromptId != null) {
        result = await waitPrompt(steeredPromptId);
        if (!terminal) finish(result?.stopReason === 'end_turn' ? null : (result?.stopReason || 'Cursor turn cancelled'));
      } else {
        finish('Cursor turn cancelled');
      }
    } else {
      finish(result?.stopReason ? `Cursor ${result.stopReason}` : null);
    }
  } catch (error) {
    finish(signal?.aborted ? 'Cursor stopped' : (error?.message || 'Cursor ACP failed'));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    clearTimeout(finishTimer);
    invalidate();
    rpc?.close();
    if (child && child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGTERM'); } catch { /* */ }
      await new Promise((r) => {
        const t = setTimeout(r, 3000);
        child.once('close', () => { clearTimeout(t); r(); });
      });
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGKILL'); } catch { /* */ }
      }
    }
  }

  return {
    res: { code: parsedOut.turnCompleted ? 0 : 1 },
    parsedOut,
  };
}
