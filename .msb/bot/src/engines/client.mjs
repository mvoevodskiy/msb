/**
 * Helper state/result reader; publication is owned by [request](./request.mjs).
 * Existing consumers: [native controls](./telegram.mjs), [Pult routes](../telegram/routes/system.mjs).
 * Read-only refresh is cancellable; publication success is not execution.
 * [Checks](../../tests/engines-client.test.mjs), [publication boundary](../../tests/engines-publication.test.mjs).
 */
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import profile from '../../shared/profile.cjs';
import { submitRequest } from './request.mjs';
export { engineDir, requestPath, newRequestId, submitRequest } from './request.mjs';

const RUN_CANDIDATES = ['/run/msb-engine/state.json'];

export async function readEngineState() {
  for (const p of RUN_CANDIDATES) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const st = JSON.parse(raw);
      if (st && typeof st === 'object') return { path: p, state: st };
    } catch {
      /* next */
    }
  }
  return { path: null, state: null };
}

/**
 * Дождаться результата заявки в state.requests[id] / state.last.
 */
export async function waitRequestResult(id, { timeoutMs = 60_000, pollMs = 400, signal } = {}) {
  signal?.throwIfAborted();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    signal?.throwIfAborted();
    const { state } = await readEngineState();
    if (state) {
      const byId = state.requests?.[id];
      if (byId && byId.result && byId.result !== 'running') return byId;
      if (state.last?.id === id && state.last.result && state.last.result !== 'running') {
        return state.last;
      }
    }
    await delay(pollMs, undefined, { signal });
  }
  return null;
}

export async function engineStatusSnapshot() {
  const { state, path: p } = await readEngineState();
  if (!state) {
    return {
      helper: null,
      path: p,
      jarvis: null,
      openclaw: null,
      pult: null,
      actions: [],
      last: null,
      error: 'NO_STATE',
    };
  }
  return {
    helper: state.helper || state.helper_version || null,
    path: p,
    msb: state.msb || state.jarvis || null,
    jarvis: state.jarvis || state.msb || null,
    openclaw: state.openclaw || null,
    pult: state.pult || null,
    actions: state.actions?.client || [],
    last: state.last || null,
    host_ready: state.host_ready,
    at: state.at,
  };
}

/** One existing status round trip for native controls and Pult; no enable/reload. */
export async function refreshEngineStatus({ signal, timeoutMs = 20_000, pollMs = 400 } = {}, env = process.env) {
  const { id } = await submitRequest('status', { bot_id: profile.botId(env) }, env, { signal });
  const result = await waitRequestResult(id, { timeoutMs, pollMs, signal });
  signal?.throwIfAborted();
  const snapshot = await engineStatusSnapshot();
  signal?.throwIfAborted();
  return { id, result, snapshot };
}
