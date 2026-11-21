/**
 * Retain only confirmed Codex session IDs for per-bot usage accounting.
 * [User-visible ledger](./ledger.mjs) remains bounded; [introduction](../agent/codex-bootstrap.mjs)
 * and the Pult collector share this index. Tests: [session ledger](../../tests/session-ledger.test.mjs).
 */
const CODEX_ID = /^ext:codex:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
const valid = value => typeof value === 'string' && CODEX_ID.test(value);

export function rememberCodexUsageSession(state, id) {
  if (!valid(id)) return false;
  if (state.codexUsageSessions !== undefined && !Array.isArray(state.codexUsageSessions)) return false;
  const existing = state.codexUsageSessions || [];
  if (existing.some(value => !valid(value))) return false;
  const history = Array.isArray(state.sessionHistory) ? state.sessionHistory : [];
  const fromHistory = history.filter(row => row && (row.engine === undefined || row.engine === 'cc') &&
    (row.providerId === undefined || row.providerId === 'codex') && valid(row.id)).map(row => row.id);
  const candidates = [...existing, ...fromHistory, state.parkedCcSessions?.codex, state.ccSessionId, id];
  const next = [...new Set(candidates.filter(valid))];
  if (state.codexUsageSessions !== undefined && next.length === existing.length && next.every((value, i) => value === existing[i])) return false;
  state.codexUsageSessions = next;
  return true;
}
