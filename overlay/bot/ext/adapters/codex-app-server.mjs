/** Codex app-server transport; caller owns session persistence and process group.
 * Adapter: ./codex.mjs; protocol/steering tests: ../tests/codex-app-server.test.mjs.
 * No retries: an unanswered RPC may already have been accepted.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { codexHttpProviderOverrides } from '../codex-transport.mjs';
import { isValidCodexThreadId } from '../codex-native.mjs';
import { isCodexStreamCutMessage } from './codex-stream-cut.mjs';

const input = text => [{ type: 'text', text, text_elements: [] }];
const usageFields = { inputTokens: 'input_tokens', cachedInputTokens: 'cached_input_tokens', cacheWriteInputTokens: 'cache_write_input_tokens', outputTokens: 'output_tokens', reasoningOutputTokens: 'reasoning_output_tokens' };
const normalizeUsage = value => {
  if (!value || Object.keys(usageFields).some(key => !Number.isFinite(value[key]) || value[key] < 0)) return null;
  return Object.fromEntries(Object.entries(usageFields).map(([from, to]) => [to, value[from]]));
};

export async function runCodexAppServerTurn({ bin, cwd, childEnv, model, effort, resumeId, prompt,
  mcpArgs = [], forceHttp, httpProviderId, onThreadStarted, onSteerReady, timeoutMs = 1_800_000 }) {
  const parsedOut = { text: '', assistantText: '', lastAssistantText: '', threadId: null,
    usage: null, turnCompleted: false, turnFailed: null, streamCut: false };
  let child, closed = false, terminal = false, threadId, turnId, ready = false, serverFailure = false, stderrTail = '';
  let nextId = 1, terminalResolve, finishTimer, lastUsage;
  const pending = new Map(), buffered = [], messages = new Map();
  const done = new Promise(resolve => { terminalResolve = resolve; });
  const invalidate = () => { if (ready) { ready = false; try { onSteerReady?.(null); } catch {} } };
  const fail = (reason, streamCut = false) => { if (terminal) return; terminal = true; invalidate(); parsedOut.turnFailed = reason; parsedOut.streamCut = streamCut; const texts = [...messages.values()].filter(t => t.trim()); parsedOut.text = texts.at(-1) || ''; parsedOut.lastAssistantText = parsedOut.text; parsedOut.assistantText = texts.join('\n\n'); failPending(); terminalResolve(); };
  const failPending = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('RPC outcome unknown')); } pending.clear(); };
  const send = msg => { if (closed || !child?.stdin.writable) throw Error('connection closed'); child.stdin.write(JSON.stringify(msg) + '\n'); };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('RPC outcome unknown')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); } catch { clearTimeout(timer); pending.delete(id); reject(Error('RPC outcome unknown')); }
  });
  const observe = ({ method, params: p }) => {
    if (!p || p.threadId !== threadId || !turnId) return;
    if (method === 'item/completed' && p.turnId === turnId && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
      messages.set(p.item.id, p.item.text);
    }
    if (method === 'thread/tokenUsage/updated' && p.turnId === turnId) {
      const total = normalizeUsage(p.tokenUsage?.total);
      if (total) lastUsage = total;
    }
    if (method === 'turn/completed' && p.turn?.id === turnId) {
      if (terminal) return;
      terminal = true; invalidate();
      const items = Array.isArray(p.turn.items) ? p.turn.items : [];
      for (const item of items) if (item.type === 'agentMessage' && typeof item.text === 'string') messages.set(item.id, item.text);
      const texts = [...messages.values()].filter(t => t.trim());
      parsedOut.text = texts.at(-1) || ''; parsedOut.lastAssistantText = parsedOut.text; parsedOut.assistantText = texts.join('\n\n');
      if (p.turn.status === 'completed' && !serverFailure) { parsedOut.turnCompleted = true; if (lastUsage) parsedOut.usage = lastUsage; }
      else parsedOut.turnFailed = p.turn.error?.message || (serverFailure ? 'Server request unsupported' : `Turn ${p.turn.status || 'failed'}`);
      terminalResolve();
    }
  };
  try {
    const args = [...codexHttpProviderOverrides(forceHttp, httpProviderId), ...mcpArgs, 'app-server'];
    child = spawn(bin, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderrTail = (stderrTail + data).slice(-8192); });
    child.stdin.on('error', () => { failPending(); fail('Codex connection lost', isCodexStreamCutMessage(stderrTail)); });
    child.on('error', () => { failPending(); fail('Codex process failed'); });
    child.on('close', () => { closed = true; failPending(); fail('Codex process exited unexpectedly', isCodexStreamCutMessage(stderrTail)); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method && msg.id !== undefined) {
        serverFailure = true;
        try { send({ id: msg.id, error: { code: -32601, message: 'Unsupported server request' } }); } catch {}
        fail('Codex server request unsupported'); return;
      }
      if (msg.method) { if (!turnId) buffered.push(msg); else observe(msg); return; }
      const p = pending.get(msg.id); if (!p) return;
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(Error('RPC error'), { rejected: true })); else p.resolve(msg.result);
    });
    finishTimer = setTimeout(() => fail('Codex timeout', true), timeoutMs);
    await request('initialize', { clientInfo: { name: 'msb_codex', version: '1' } });
    send({ method: 'initialized' });
    const config = { cwd, sandbox: 'danger-full-access', approvalPolicy: 'never', ...(model ? { model } : {}) };
    let opened;
    try { opened = await request(resumeId ? 'thread/resume' : 'thread/start', resumeId ? { ...config, threadId: resumeId } : config); }
    catch (error) { if (resumeId && error?.rejected) parsedOut.resumeRejected = true; throw error; }
    threadId = opened?.thread?.id;
    if (!isValidCodexThreadId(threadId) || (resumeId && threadId !== resumeId)) throw Error('Codex thread mismatch');
    parsedOut.threadId = threadId;
    if (!resumeId) onThreadStarted?.(threadId);
    const started = await request('turn/start', { threadId, input: input(prompt), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    turnId = started?.turn?.id;
    if (typeof turnId !== 'string' || !turnId) throw Error('Codex turn ID missing');
    for (const msg of buffered) observe(msg);
    if (!terminal) {
      ready = true;
      const handle = { threadId, turnId, invalidate, async steer(text) {
        if (!ready || terminal) return { status: 'rejected' };
        try { const result = await request('turn/steer', { threadId, expectedTurnId: turnId, input: input(text) });
          return { status: result?.turnId === turnId ? 'accepted' : 'unknown' };
        } catch { return { status: 'unknown' }; }
      } };
      try { onSteerReady?.(handle); } catch { invalidate(); }
    }
    await done;
  } catch { fail('Codex app-server request failed'); }
  finally {
    clearTimeout(finishTimer); invalidate(); failPending();
    if (child && !closed) {
      child.stdin.end();
      const exited = () => new Promise(resolve => {
        if (closed) return resolve(true);
        const timer = setTimeout(() => { child.off('close', onClose); resolve(false); }, 3000);
        const onClose = () => { clearTimeout(timer); resolve(true); };
        child.once('close', onClose);
      });
      if (!await exited()) {
        child.kill('SIGTERM');
        if (!await exited()) { child.kill('SIGKILL'); await exited(); }
      }
    }
  }
  return { res: { code: parsedOut.turnCompleted ? 0 : 1 }, parsedOut, model };
}
