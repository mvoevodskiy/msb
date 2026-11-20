/**
 * Minimal newline JSON-RPC over a child stdio pair (Cursor/Grok ACP).
 * Caller owns spawn/lifecycle; this only frames requests and notifications.
 */
import { createInterface } from 'node:readline';

export function createAcpRpc(child, { onNotification, onServerRequest, timeoutMs = 1_800_000 } = {}) {
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  const failPending = (reason = 'connection closed') => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(Error(reason), { closed: true }));
    }
    pending.clear();
  };

  const send = (msg) => {
    if (closed || !child.stdin?.writable) throw Object.assign(Error('connection closed'), { closed: true });
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  lines.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg?.method && msg.id !== undefined) {
      try { onServerRequest?.(msg, (result) => send({ jsonrpc: '2.0', id: msg.id, result })); }
      catch { try { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'handler failed' } }); } catch { /* */ } }
      return;
    }
    if (msg?.method) {
      try { onNotification?.(msg); } catch { /* observer cannot break the turn */ }
      return;
    }
    const p = pending.get(msg?.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(Object.assign(Error(msg.error.message || 'RPC error'), { rejected: true, error: msg.error }));
    else p.resolve(msg.result);
  });

  const onClose = () => {
    if (closed) return;
    closed = true;
    failPending();
  };
  child.stdin?.on('error', onClose);
  child.on('close', onClose);
  child.on('error', onClose);

  return {
    get closed() { return closed; },
    request(method, params, { waitMs = timeoutMs } = {}) {
      if (closed) return Promise.reject(Object.assign(Error('connection closed'), { closed: true }));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(Error('RPC timeout'), { timeout: true }));
        }, waitMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ jsonrpc: '2.0', id, method, params }); }
        catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    /**
     * Send a request and keep a waiter slot immediately (avoids losing a fast
     * response before the caller awaits takeResult).
     */
    notifyRequest(method, params, { waitMs = timeoutMs } = {}) {
      if (closed) throw Object.assign(Error('connection closed'), { closed: true });
      const id = nextId++;
      let settle;
      const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      const timer = setTimeout(() => {
        pending.delete(id);
        settle.reject(Object.assign(Error('RPC timeout'), { timeout: true }));
      }, waitMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); settle.resolve(v); },
        reject: (e) => { clearTimeout(timer); settle.reject(e); },
        timer,
        result,
      });
      try { send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        settle.reject(error);
      }
      return id;
    },
    takeResult(id) {
      const p = pending.get(id);
      if (p?.result) return p.result;
      return Promise.reject(Object.assign(Error('unknown request id'), { missing: true }));
    },
    close() {
      closed = true;
      failPending();
      try { child.stdin?.end(); } catch { /* */ }
    },
  };
}

export function acpTextPrompt(text) {
  return [{ type: 'text', text: String(text || '') }];
}

/** Auto-approve tool permissions for headless bot turns. */
export function allowOncePermission(respond) {
  respond({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
}
