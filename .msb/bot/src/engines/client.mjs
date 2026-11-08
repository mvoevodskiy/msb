/**
 * Helper state/result reader; publication is owned by [request](./request.mjs).
 * Existing consumers: [native controls](./telegram.mjs), [Pult routes](../telegram/routes/system.mjs).
 * [Checks](../../tests/engines-client.test.mjs), [publication boundary](../../tests/engines-publication.test.mjs).
 */
import fs from 'node:fs/promises';
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
export async function waitRequestResult(id, { timeoutMs = 60_000, pollMs = 400 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { state } = await readEngineState();
    if (state) {
      const byId = state.requests?.[id];
      if (byId && byId.result && byId.result !== 'running') return byId;
      if (state.last?.id === id && state.last.result && state.last.result !== 'running') {
        return state.last;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
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
