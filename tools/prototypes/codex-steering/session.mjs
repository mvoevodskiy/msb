/**
 * Experimental native Codex thread/turn driver for [prototype queue](./queue.mjs).
 * Callers supply a disposable process environment and workspace; this module
 * never opens or resumes an existing user thread. [Loopback probe](./native-loopback.mjs).
 */
import { spawn } from 'node:child_process';
import { RpcClient, RpcUnknown } from './rpc.mjs';

const textInput = text => [{ type: 'text', text, text_elements: [] }];
const groupExists = pid => {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

export class NativeSession {
  static async open({ command, cwd, env, args = [], timeoutMs = 15_000, onEvent = () => {} }) {
    const child = spawn(command, [...args, 'app-server'], {
      cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const session = new NativeSession(child, { timeoutMs, onEvent });
    try {
      await session.rpc.request('initialize', { clientInfo: { name: 'msb_steer_prototype', version: '1' } });
      session.rpc.notify('initialized');
      const result = await session.rpc.request('thread/start', {
        cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      });
      if (!result?.thread?.id) throw Error('native thread was not created');
      session.threadId = result.thread.id;
      return session;
    } catch (error) {
      await session.close();
      throw Error(`cannot open prototype session: ${error.message}; stderr length=${stderr.length}`);
    }
  }

  constructor(child, { timeoutMs, onEvent = () => {}, closeGraceMs = 1000,
    signalGroup = (pid, signal) => process.kill(-pid, signal), isGroupAlive = groupExists }) {
    this.child = child;
    this.threadId = null;
    this.onEvent = onEvent;
    this.closeGraceMs = closeGraceMs;
    this.signalGroup = signalGroup;
    this.isGroupAlive = isGroupAlive;
    this.childClosed = false;
    this.results = new Map();
    this.waiters = new Map();
    this.rpc = new RpcClient(child, { timeoutMs, onNotification: message => this.onNotification(message) });
    child.once('close', () => { this.childClosed = true; this.failWaiters(); });
  }

  onNotification(message) {
    this.onEvent(message);
    const params = message.params;
    if (message.method !== 'turn/completed' || params?.threadId !== this.threadId || !params.turn?.id) return;
    const turn = { status: params.turn.status };
    const waiter = this.waiters.get(params.turn.id);
    if (waiter) { this.waiters.delete(params.turn.id); waiter.resolve(turn); }
    else this.results.set(params.turn.id, turn);
  }

  failWaiters() {
    for (const waiter of this.waiters.values()) waiter.reject(new RpcUnknown('session closed'));
    this.waiters.clear();
  }

  async start(text) {
    const result = await this.rpc.request('turn/start', { threadId: this.threadId, input: textInput(text) });
    const id = result?.turn?.id;
    if (!id) throw new RpcUnknown('turn start returned no id');
    const completed = this.results.get(id);
    if (completed) { this.results.delete(id); return { id, done: Promise.resolve(completed) }; }
    if (this.rpc.closed) throw new RpcUnknown('connection closed before turn completion');
    const done = new Promise((resolve, reject) => this.waiters.set(id, { resolve, reject }));
    return { id, done };
  }

  async steer(turnId, text) {
    // A generic server error does not prove that no input was accepted.
    // Treat it as unknown; only an explicitly proven pre-acceptance rejection
    // may be translated to RejectedSteer by a future integration.
    const result = await this.rpc.request('turn/steer', {
      threadId: this.threadId, expectedTurnId: turnId, input: textInput(text),
    });
    if (result?.turnId !== turnId) throw new RpcUnknown('steer acknowledgement did not identify the expected turn');
  }

  async interrupt(turnId) {
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId });
  }

  async close() {
    if (!this.closing) this.closing = this.closeOwnedProcess();
    return this.closing;
  }

  waitForClose() {
    if (this.childClosed) return Promise.resolve(true);
    return new Promise(resolve => {
      const onClose = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { this.child.off('close', onClose); resolve(false); }, this.closeGraceMs);
      this.child.once('close', onClose);
    });
  }

  async closeOwnedProcess() {
    this.rpc.close();
    this.failWaiters();
    if (await this.waitForClose()) return this.confirmGroupGone();
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      // Once the leader has exited, its PID could be reused. Do not signal
      // an unverified process group just because a descendant holds a pipe.
      if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid) {
        try { this.signalGroup(this.child.pid, signal); } catch {}
      }
      if (await this.waitForClose()) return this.confirmGroupGone();
    }
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.unref();
    throw new RpcUnknown('could not confirm test process and its descendants exited');
  }

  confirmGroupGone() {
    // A leader can close stdio while a same-group child keeps running.
    // Processes that deliberately leave the group require stronger isolation.
    if (this.child.pid && this.isGroupAlive(this.child.pid)) {
      throw new RpcUnknown('test process group still has running members');
    }
  }
}
