/**
 * Grok Build ACP (`grok agent stdio`) with mid-turn interject when available.
 * Prefer `_x.ai/interject` (queues into the running turn without cancelling tools).
 * If the method is missing (-32601), fall back to Cursor-style send-now
 * (second `session/prompt`). Ordinary non-steer turns keep [grok.mjs](./grok.mjs) `-p`.
 * RPC → [acp-rpc](./acp-rpc.mjs).
 */
import { spawn } from 'node:child_process';
import { isGrokSessionId } from './grok.mjs';
import { createAcpRpc, acpTextPrompt, allowOncePermission } from './acp-rpc.mjs';

export async function runGrokAcpTurn({
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
  let interjectSupported = true;
  let steeredPromptId = null;
  let activePromptId = null;
  let finishTimer;
  let terminalResolve;
  const done = new Promise((resolve) => { terminalResolve = resolve; });
  const chunks = [];

  const invalidate = () => {
    if (!ready) return;
    ready = false;
    try { onSteerReady?.(null); } catch { /* */ }
  };

  const finish = (failed = null) => {
    if (terminal) return;
    terminal = true;
    invalidate();
    parsedOut.text = chunks.join('').trim();
    if (failed) parsedOut.turnFailed = failed;
    else parsedOut.turnCompleted = true;
    terminalResolve();
  };

  const onAbort = () => finish('Grok stopped');

  try {
    signal?.throwIfAborted();
    child = spawn(bin, ['agent', 'stdio', '--no-auto-update'], {
      cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});

    rpc = createAcpRpc(child, {
      timeoutMs,
      onNotification(msg) {
        if (msg.method !== 'session/update') return;
        const update = msg.params?.update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
          chunks.push(String(update.content.text));
        }
      },
      onServerRequest(msg, respond) {
        if (msg.method === 'session/request_permission') allowOncePermission(respond);
        else respond({});
      },
    });

    signal?.addEventListener('abort', onAbort, { once: true });
    finishTimer = setTimeout(() => finish('Grok timeout'), timeoutMs);

    const init = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'msb_grok', version: '1' },
    });
    const authMethods = new Set((init?.authMethods || []).map((m) => m.id));
    const methodId = childEnv.XAI_API_KEY && authMethods.has('xai.api_key')
      ? 'xai.api_key'
      : authMethods.has('cached_token')
        ? 'cached_token'
        : [...authMethods][0] || 'cached_token';
    try {
      await rpc.request('authenticate', { methodId, _meta: { headless: true } });
    } catch {
      // Some builds already have a session from ~/.grok/auth.json.
    }

    if (resumeId && isGrokSessionId(resumeId)) {
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
    if (!isGrokSessionId(sessionId)) throw Error('Grok session ID missing');
    parsedOut.sessionId = sessionId;

    const promptParams = {
      sessionId,
      prompt: acpTextPrompt(prompt),
      ...(model ? { model } : {}),
    };
    activePromptId = rpc.notifyRequest('session/prompt', promptParams);

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
          if (interjectSupported) {
            try {
              const result = await rpc.request('_x.ai/interject', { sessionId, text }, { waitMs: 15_000 });
              const status = result?.status || result?.result?.status;
              if (status === 'queued' || status === 'injected' || result == null) return { status: 'accepted' };
              if (status) return { status: 'accepted' };
              return { status: 'accepted' };
            } catch (error) {
              if (error?.error?.code === -32601 || /not found/i.test(error?.message || '')) {
                interjectSupported = false;
              } else if (error?.timeout) {
                return { status: 'unknown' };
              } else {
                return { status: 'unknown' };
              }
            }
          }
          try {
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

    const waitPrompt = async (id) => {
      try {
        return await rpc.takeResult(id, { waitMs: timeoutMs });
      } catch (error) {
        if (error?.timeout) return finish('Grok timeout');
        if (error?.closed || signal?.aborted) return finish(signal?.aborted ? 'Grok stopped' : 'Grok connection lost');
        return finish(error?.message || 'Grok ACP request failed');
      }
    };

    let result = await waitPrompt(activePromptId);
    if (terminal) { /* done */ }
    else if (steeredPromptId != null) {
      chunks.length = 0;
      result = await waitPrompt(steeredPromptId);
      if (!terminal) finish(result?.stopReason === 'end_turn' ? null : (result?.stopReason || null));
    } else if (result?.stopReason === 'end_turn' || result?.stopReason === 'cancelled' && steeredPromptId != null) {
      if (result?.stopReason === 'cancelled' && steeredPromptId != null) {
        chunks.length = 0;
        result = await waitPrompt(steeredPromptId);
        if (!terminal) finish(result?.stopReason === 'end_turn' ? null : (result?.stopReason || null));
      } else {
        finish(result?.stopReason === 'end_turn' ? null : (result?.stopReason || null));
      }
    } else {
      finish(result?.stopReason && result.stopReason !== 'end_turn' ? `Grok ${result.stopReason}` : null);
    }
  } catch (error) {
    finish(signal?.aborted ? 'Grok stopped' : (error?.message || 'Grok ACP failed'));
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

  return { res: { code: parsedOut.turnCompleted ? 0 : 1 }, parsedOut };
}
