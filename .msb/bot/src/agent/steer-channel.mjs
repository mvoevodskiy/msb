/**
 * Per-turn control pipe from [Claude envelope](./claude.mjs) to the Codex shim.
 * [Turn](./turn.mjs) binds readiness to its captured session; Telegram selects
 * a queued message through [inbox](../telegram/inbox.mjs). Unknown delivery is
 * never presented as a rejection. [Checks](../../tests/steer-channel.test.mjs).
 */

export function createSteerChannel(stream, { onReady = () => {}, timeoutMs = 15_000 } = {}) {
  let closed = false, current = null, input = '', next = 0;
  const pending = new Map();
  const notify = value => { try { onReady(value); } catch { /* observer cannot affect the turn */ } };

  function settle(id, status) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timer); item.resolve({ status });
  }
  function invalidate() {
    if (!current) return;
    current = null;
    notify(null);
  }
  function close() {
    if (closed) return;
    closed = true;
    invalidate();
    for (const id of [...pending.keys()]) settle(id, 'unknown');
  }

  function onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready' && typeof message.threadId === 'string' && message.threadId &&
        typeof message.turnId === 'string' && message.turnId) {
      invalidate();
      const identity = { threadId: message.threadId, turnId: message.turnId };
      const handle = {
        ...identity,
        get active() { return !closed && current === handle; },
        steer(text) {
          if (closed || current !== handle) return Promise.resolve({ status: 'unavailable' });
          if (typeof text !== 'string' || !text.trim() || text.length > 1_000_000) {
            return Promise.resolve({ status: 'rejected' });
          }
          const id = String(++next);
          return new Promise(resolve => {
            const timer = setTimeout(() => settle(id, 'unknown'), timeoutMs);
            pending.set(id, { timer, resolve });
            try {
              stream.write(JSON.stringify({ type: 'steer', id, ...identity, text }) + '\n', error => {
                if (error) settle(id, 'unknown');
              });
            } catch { settle(id, 'unknown'); }
          });
        },
      };
      current = handle;
      notify(handle);
    } else if (message.type === 'closed') {
      invalidate();
    } else if (message.type === 'result' && typeof message.id === 'string') {
      const status = ['accepted', 'rejected', 'unknown'].includes(message.status) ? message.status : 'unknown';
      settle(message.id, status);
    }
  }

  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    input += chunk;
    if (input.length > 2_000_000) { close(); return; }
    let newline;
    while ((newline = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, newline); input = input.slice(newline + 1);
      try { onMessage(JSON.parse(line)); } catch { /* ignore malformed control records */ }
    }
  });
  stream.once('error', close);
  stream.once('end', close);
  stream.once('close', close);
  return { close };
}
