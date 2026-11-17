/**
 * Stdio JSON-RPC for the isolated [Codex session](./session.mjs). A rejected
 * response differs from an unanswered request, whose delivery is unknown.
 */
import { createInterface } from 'node:readline';

export class RpcRejected extends Error {
  constructor(method, code) { super(`${method} rejected (${code})`); this.code = code; }
}
export class RpcUnknown extends Error {}

export class RpcClient {
  constructor(child, { timeoutMs = 15_000, onNotification = () => {} } = {}) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.onNotification = onNotification;
    this.pending = new Map();
    this.next = 1;
    this.closed = false;
    this.lines = createInterface({ input: child.stdout });
    child.stdin.on('error', () => this.failPending());
    child.once('error', () => this.failPending());
    child.once('close', () => this.failPending());
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        if (message.id === undefined) this.onNotification(message);
        else {
          // A server request is not a reply to our request, even if IDs happen
          // to match. This disposable probe never approves server requests.
          try { this.send({ id: message.id, error: { code: -32601, message: 'unsupported by prototype' } }); }
          catch { this.failPending(); }
        }
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new RpcRejected(request.method, message.error.code));
      else request.resolve(message.result);
    });
  }

  send(message) {
    if (this.closed || !this.child.stdin.writable) throw new RpcUnknown('connection closed');
    try { this.child.stdin.write(JSON.stringify(message) + '\n'); }
    catch { throw new RpcUnknown('write outcome unknown'); }
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new RpcUnknown('connection closed'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcUnknown(`${method} acknowledgement timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { method, timer, resolve, reject });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) { this.send({ method, params }); }

  failPending() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new RpcUnknown(`${item.method} connection lost`));
    }
    this.pending.clear();
  }

  close() {
    this.failPending();
    this.lines.close();
    this.child.stdin.end();
  }
}
