/**
 * Wake one sleeping bot, falling back to the existing msb-engine action.
 * Called by [Telegram route](../telegram/routes/engines.mjs); publishing and
 * results stay in [client](./client.mjs). No provider/session state is changed.
 * Reference and failure checks: [engine-wake-fallback](../../tests/engine-wake-fallback.test.mjs).
 */
import { engineStatusSnapshot, submitRequest, waitRequestResult } from './client.mjs';

// msb-engine.service has a 10-minute deadline. Allow publication and state
// propagation before treating its abandoned "running" result as stale.
const RUNNING_WINDOW_MS = 630_000;
const defaults = { snapshot: engineStatusSnapshot, submit: submitRequest, wait: waitRequestResult };

export async function wakeWithFallback(sleep, { botId, signal, io = defaults, now = Date.now } = {}) {
  if (!sleep) return false;
  const attempt = await sleep.wakeAttempt();
  if (attempt.ok) return true;
  if (!attempt.revision) return false;
  try {
    signal?.throwIfAborted();
    const snapshot = await io.snapshot();
    if (!snapshot?.helper || snapshot.hold === true || snapshot.host_ready === false ||
        !snapshot.actions?.includes('enable-msb')) return false;
    const last = snapshot.last;
    if (last?.result === 'running') {
      const at = Date.parse(last.at || '');
      if (!Number.isFinite(at) || now() - at < RUNNING_WINDOW_MS) return false;
    }
    const { id } = await io.submit('enable-msb', { bot_id: botId, sleep_revision: attempt.revision }, process.env, { signal });
    const result = await io.wait(id, { timeoutMs: RUNNING_WINDOW_MS, signal });
    if (result?.result !== 'done' || result.code !== 'OK') return false;
    // Never unlink again: another operation may have created a newer marker
    // since the service removed the old one. Resume only while it is absent.
    return await sleep.resumeIfAwake();
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}
