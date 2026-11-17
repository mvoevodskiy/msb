/**
 * Optional private fd from the [core turn envelope](../../../../.msb/bot/src/agent/claude.mjs).
 * Bridges queued text to the current [Codex app-server](../adapters/codex-app-server.mjs),
 * never to another provider or native turn. [Checks](../tests/steer-control.test.mjs).
 */
import net from 'node:net';

export function createShimSteerControl(stream) {
  let current = null, closed = false, buffer = '';
  function send(value) {
    if (closed) return;
    try { stream.write(JSON.stringify(value) + '\n'); } catch { closed = true; current = null; }
  }
  function ready(handle) {
    current = handle || null;
    if (!handle) return send({ type: 'closed' });
    if (typeof handle.threadId !== 'string' || !handle.threadId || typeof handle.turnId !== 'string' || !handle.turnId ||
        typeof handle.steer !== 'function') { current = null; return send({ type: 'closed' }); }
    send({ type: 'ready', threadId: handle.threadId, turnId: handle.turnId });
  }
  async function onMessage(message) {
    if (message?.type !== 'steer' || typeof message.id !== 'string' || !/^\d{1,20}$/.test(message.id)) return;
    const handle = current;
    if (!handle || message.threadId !== handle.threadId || message.turnId !== handle.turnId ||
        typeof message.text !== 'string' || !message.text.trim() || message.text.length > 1_000_000) {
      return send({ type: 'result', id: message.id, status: 'rejected' });
    }
    let status = 'unknown';
    try {
      const result = await handle.steer(message.text);
      if (['accepted', 'rejected', 'unknown'].includes(result?.status)) status = result.status;
    } catch { /* delivery may already have happened */ }
    send({ type: 'result', id: message.id, status });
  }
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 2_000_000) { closed = true; current = null; stream.destroy(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { Promise.resolve(onMessage(JSON.parse(line))).catch(() => {}); } catch { /* ignore invalid control records */ }
    }
  });
  const finish = () => { closed = true; current = null; };
  stream.once('error', finish); stream.once('close', finish); stream.once('end', finish);
  return { ready, close() { ready(null); finish(); stream.end(); } };
}

export function openShimSteerControl(env = process.env) {
  if (env.MSB_CODEX_STEER_FD !== '3') return null;
  try { return createShimSteerControl(new net.Socket({ fd: 3, readable: true, writable: true })); }
  catch { return null; }
}
