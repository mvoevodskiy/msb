/**
 * Disposable steering experiment; not imported by the bot's runtime.
 * Owns only an in-memory test queue; [native session](./session.mjs) owns RPC.
 * Verify transitions and races with [queue.test.mjs](./queue.test.mjs).
 * Production still owns its separate [inbox](../../../.msb/bot/src/telegram/inbox.mjs).
 */

export class RejectedSteer extends Error {}

async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(value => ({ value }), error => ({ error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export class PrototypeQueue {
  constructor({ driver, scope = 'fixture', notify = () => {}, stopTimeoutMs = 5000 }) {
    this.driver = driver;
    this.scope = scope;
    this.notify = notify;
    this.pending = [];
    this.active = null;
    this.generation = 0;
    this.ids = new Set();
    this.closed = false;
    this.fenced = false;
    this.cleanupUnconfirmed = false;
    this.stopping = 0;
    this.stopTimeoutMs = stopTimeoutMs;
  }

  submit({ id, text, scope = this.scope }) {
    if (this.closed || this.fenced) throw Error('prototype queue closed or fenced');
    if (typeof id !== 'string' || !id || this.ids.has(id)) throw Error('invalid or duplicate id');
    if (typeof text !== 'string' || !text.trim()) throw Error('empty message');
    if (scope !== this.scope) throw Error('scope mismatch');
    this.ids.add(id);
    this.pending.push({ id, text, scope, state: 'queued' });
    this.notify({ type: 'queued', id });
    this.pump();
  }

  pump() {
    // A reservation has an uncertain outcome until the reply arrives; do not
    // start another turn and accidentally deliver it twice or to a new turn.
    if (this.closed || this.fenced || this.stopping || this.active || this.pending.some(item => item.state !== 'queued')) return;
    const entry = this.pending.shift();
    if (!entry) return;
    const active = { entry, id: null, stopRequested: false, outcome: null };
    active.ready = new Promise(resolve => { active.readyResolve = resolve; });
    this.active = active;
    active.task = (async () => {
      try {
        const turn = await this.driver.start(entry.text);
        active.id = turn.id;
        active.readyResolve(turn.id);
        this.notify({ type: 'started', id: entry.id, turnId: turn.id });
        // Stop waits for both the interrupt acknowledgement and turn/completed.
        const result = await turn.done;
        active.outcome = result;
        this.notify({ type: 'finished', id: entry.id, status: result.status });
      } catch (error) {
        active.readyResolve(null);
        this.fenced = true;
        this.notify({ type: 'failed', id: entry.id, error });
      } finally {
        if (this.active === active) this.active = null;
        this.pump();
      }
    })();
  }

  interrupt(active) {
    if (!active.interruptPromise) active.interruptPromise = Promise.resolve().then(() => this.driver.interrupt(active.id));
    return active.interruptPromise;
  }

  async steer(id, scope = this.scope) {
    const entry = this.pending.find(item => item.id === id);
    const active = this.active;
    if (!entry || entry.state !== 'queued') return { status: 'not-queued' };
    if (scope !== this.scope || entry.scope !== scope) return { status: 'scope-mismatch' };
    if (!active?.id || active.stopRequested) return { status: 'not-active' };
    if (active.entry.scope !== scope) return { status: 'scope-mismatch' };
    if (typeof this.driver.steer !== 'function') return { status: 'unsupported' };
    const generation = this.generation;
    entry.state = 'reserved';
    try {
      await this.driver.steer(active.id, entry.text);
      if (generation !== this.generation) return { status: 'stopped' };
      this.pending = this.pending.filter(item => item !== entry);
      this.notify({ type: 'steered', id, turnId: active.id });
      return { status: 'accepted' };
    } catch (error) {
      if (generation !== this.generation) return { status: 'stopped' };
      if (error instanceof RejectedSteer) {
        entry.state = 'queued';
        this.notify({ type: 'steer-rejected', id });
        return { status: 'rejected' };
      }
      entry.state = 'unknown';
      this.notify({ type: 'steer-unknown', id });
      return { status: 'unknown' };
    } finally {
      this.pump();
    }
  }

  async stop() {
    this.generation++;
    const cleared = this.pending.splice(0).map(item => item.id);
    const active = this.active;
    this.stopping++;
    let uncertain = false;
    try {
      if (active) {
        active.stopRequested = true;
        const wait = (async () => {
          const id = await active.ready;
          if (!id) return false;
          await this.interrupt(active);
          await active.task;
          return active.outcome?.status === 'interrupted';
        })();
        const result = await bounded(wait, this.stopTimeoutMs);
        uncertain = Boolean(result.timeout || result.error || result.value !== true || this.fenced);
      } else uncertain = this.fenced;
      if (uncertain) {
        // Unknown start/interrupt: close the disposable session and never
        // start queued work merely because the local request failed.
        this.fenced = true;
        this.closed = true;
        if (typeof this.driver.close === 'function') {
          const cleanup = await bounded(Promise.resolve().then(() => this.driver.close()), this.stopTimeoutMs);
          if (cleanup.timeout || cleanup.error) this.cleanupUnconfirmed = true;
        } else this.cleanupUnconfirmed = true;
      }
      const outcome = { cleared, active: Boolean(active), ...(uncertain ? { status: 'unknown' } : {}),
        ...(this.cleanupUnconfirmed ? { cleanup: 'unconfirmed' } : {}) };
      this.notify({ type: 'stop', ...outcome });
      return outcome;
    } finally {
      this.stopping--;
      this.pump();
    }
  }

  async close() {
    this.closed = true;
    await this.stop();
    if (this.cleanupUnconfirmed) throw Error('prototype driver cleanup not confirmed');
  }
}
