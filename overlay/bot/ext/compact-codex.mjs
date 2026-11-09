/**
 * Native Codex compaction with [scoped MCP removal](./codex-mcp-launch.mjs).
 * An RPC acknowledgement alone is not success.
 */
import { spawn } from 'node:child_process';
import { findBin } from './adapters/run-cli.mjs';
import { decodeExtSession, loadStore } from './store.mjs';
import { isValidCodexThreadId } from './codex-native.mjs';
import { codexChildEnvironment } from './codex-auth-env.mjs';
import {codexNativeRemoval} from '../shared/mcp-native-scope.mjs';
import {CODEX_NATIVE_MCP_ERROR,prepareCodexMcp} from './codex-mcp-launch.mjs';

export async function compactCodex(snapshot, { signal, isCurrent = async () => true, env = process.env,
  run = runCodexCompaction } = {}) {
  const session = decodeExtSession(snapshot.ccSessionId);
  if (!session || session.providerId !== 'codex' || !isValidCodexThreadId(session.nativeId)) {
    return { ok: false, error: 'Нет активной сессии Codex.' };
  }
  const auth = await codexChildEnvironment(env);
  if (!auth.configured) return { ok: false, error: 'Авторизация Codex не найдена.' };
  const bin = findBin('codex', auth.env);
  if (!bin) return { ok: false, error: 'Codex CLI не найден.' };
  const store = await loadStore(env);
  const cwd=process.cwd();
  const removal=await codexNativeRemoval(snapshot,cwd,auth.env);
  let mcp;
  if(removal){
    mcp=await prepareCodexMcp(bin,cwd,{
      ...auth.env,MSB_TURN_MCP_TEMPLATES:undefined,MSB_TURN_MCP_CUSTOM:undefined,MSB_TURN_MCP_REMOVE:JSON.stringify(removal),
    },{signal,ownProcessGroup:true});
    if(signal?.aborted || !await isCurrent())return {ok:false,aborted:true};
    if(mcp.blocked)return {ok:false,error:CODEX_NATIVE_MCP_ERROR};
  }
  return run({
    command: bin, threadId: session.nativeId, model: store.models?.codex,
    effort: store.efforts?.codex, signal, isCurrent, env: mcp?.env ?? auth.env,
    ...(mcp?.args.length?{mcpArgs:mcp.args}:{}),
  });
}

export function runCodexCompaction({ command, threadId, model, effort, signal,
  isCurrent = async () => true, env = process.env, mcpArgs=[], timeoutMs = 180_000, spawnProcess = spawn } = {}) {
  if (!isValidCodexThreadId(threadId)) return Promise.resolve({ ok: false, error: 'Нет активной сессии Codex.' });
  if (signal?.aborted) return Promise.resolve({ ok: false, aborted: true });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(command, [...mcpArgs,'app-server'], { env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve({ ok: false, error: 'Не удалось запустить Codex CLI.' });
      return;
    }
    let result = null, closed = false, buffer = '', phase = 'init', accepted = false;
    const compactItems = new Set(), completedTurns = new Set();
    let timeout, terminateTimer, killTimer;

    function signalGroup(name) {
      if (closed) return;
      try { if (child.pid) { process.kill(-child.pid, name); return; } } catch { /* fall through */ }
      try { child.kill(name); } catch { /* already closed */ }
    }
    function finish(value) {
      if (result) return;
      result = value;
      clearTimeout(timeout);
      try { child.stdin.end(); } catch { /* already closed */ }
      if (value.aborted) signalGroup('SIGINT');
      terminateTimer = setTimeout(() => signalGroup('SIGTERM'), 1_000);
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 5_000);
      terminateTimer.unref?.(); killTimer.unref?.();
      if (closed) complete();
    }
    function complete() {
      clearTimeout(timeout); clearTimeout(terminateTimer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result || { ok: false, error: 'Codex завершился до подтверждения сжатия.' });
    }
    function onAbort() { finish({ ok: false, aborted: true }); }
    function send(message) {
      if (!result) child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    function checkCompletion() {
      if (accepted && [...compactItems].some((id) => completedTurns.has(id))) finish({ ok: true });
    }
    async function onMessage(msg) {
      if (result) return;
      if (msg.id === 1 && phase === 'init') {
        if (msg.error || !msg.result) return finish({ ok: false, error: 'Codex не принял инициализацию.' });
        phase = 'resume';
        send({ method: 'initialized', params: {} });
        const params = { threadId, excludeTurns: true };
        if (model) params.model = model;
        if (effort) params.config = { model_reasoning_effort: effort };
        send({ id: 2, method: 'thread/resume', params });
      } else if (msg.id === 2 && phase === 'resume') {
        if (msg.error || msg.result?.thread?.id !== threadId) {
          return finish({ ok: false, error: 'Codex не подтвердил исходную сессию.' });
        }
        if (!await isCurrent() || signal?.aborted) return finish({ ok: false, aborted: true });
        phase = 'compact';
        send({ id: 3, method: 'thread/compact/start', params: { threadId } });
      } else if (msg.id === 3 && phase === 'compact') {
        if (msg.error || !msg.result || typeof msg.result !== 'object') {
          return finish({ ok: false, error: 'Codex отклонил сжатие.' });
        }
        accepted = true;
        checkCompletion();
      } else if (phase === 'compact' && msg.params?.threadId === threadId) {
        if (msg.method === 'item/completed' && msg.params.item?.type === 'contextCompaction' && msg.params.turnId) {
          compactItems.add(msg.params.turnId);
        }
        if (msg.method === 'turn/completed' && msg.params.turn?.id) {
          if (msg.params.turn.status !== 'completed') return finish({ ok: false, error: 'Сжатие Codex не завершилось.' });
          completedTurns.add(msg.params.turn.id);
        }
        checkCompletion();
      }
    }
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 4_000_000) return finish({ ok: false, error: 'Слишком большой ответ Codex.' });
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        Promise.resolve(onMessage(msg)).catch(() => finish({ ok: false, error: 'Ошибка обработки ответа Codex.' }));
      }
    });
    child.on('error', () => finish({ ok: false, error: 'Не удалось запустить Codex CLI.' }));
    child.on('close', () => { closed = true; complete(); });
    timeout = setTimeout(() => finish({ ok: false, error: 'Сжатие не подтвердилось вовремя.' }), timeoutMs);
    timeout.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'msb', title: 'MSB bot', version: '1' } } });
  });
}

export function registerCompactProvider(BotClass, env = process.env) {
  BotClass.prototype[Symbol.for('msb.compactProvider')] = (snapshot, options) => compactCodex(snapshot, { ...options, env });
}
