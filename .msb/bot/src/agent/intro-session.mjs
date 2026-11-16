/**
 * Retain a confirmed Codex introduction ID in the ordinary per-bot session ledger.
 * Caller: [Codex bootstrap](./codex-bootstrap.mjs), inside its existing updateState
 * transaction and only after confirming that scope's lease token is still current.
 * The ledger uses the captured project because a relative CODEX_HOME is resolved
 * against that selection. The introduction CLI itself runs from the base workspace;
 * this project field records profile/project association, not the introduction cwd.
 * The Codex thread keeps its own model context; this helper only retains its ID and
 * never merges it with or replaces another Claude/Codex conversation.
 * [Ledger](../sessions/ledger.mjs), [identity checks](../../shared/session-starts.mjs).
 */
import { recordSessionMetadata } from '../sessions/ledger.mjs';
import { selectedSessionProvider, isProviderSession } from '../../shared/session-starts.mjs';

const INTRODUCTION_DESCRIPTION = 'Знакомство';

function validExistingLedgerRow(state, sessionId, capturedProject) {
  if (!Array.isArray(state.sessionHistory)) return false;
  const rows = state.sessionHistory.filter(row => row?.id === sessionId);
  if (rows.length !== 1) return false;
  const [row] = rows;
  return (row.engine === undefined || row.engine === 'cc') &&
    (row.providerId === undefined || row.providerId === 'codex') &&
    row.project === capturedProject;
}

function hasLedgerId(state, sessionId) {
  return Array.isArray(state.sessionHistory) &&
    state.sessionHistory.some(row => row?.id === sessionId);
}

function hasCodexSlot(map) {
  return map && typeof map === 'object' && !Array.isArray(map) && Object.hasOwn(map, 'codex');
}

/**
 * Record a native introduction ID without turning a stale or conflicting result
 * into the active conversation. `prompt` is accepted for call-site symmetry but
 * deliberately never stored: the ledger description is always the fixed label.
 */
export function retainIntroductionSession(state, {
  sessionId,
  capturedProject,
  capturedEpoch,
  sameProfile,
  sameWorkspace,
  prompt: _prompt,
} = {}) {
  void _prompt;

  if (!isProviderSession(sessionId, 'codex')) return { recorded: false, activated: false };

  let recorded = false;
  if (hasLedgerId(state, sessionId)) {
    // Do not update activity/count or create an ambiguous duplicate on a retry.
    recorded = validExistingLedgerRow(state, sessionId, capturedProject);
  } else {
    recorded = recordSessionMetadata(state, {
      id: sessionId,
      providerId: 'codex',
      project: capturedProject,
      prompt: INTRODUCTION_DESCRIPTION,
    });
  }

  if (!recorded) return { recorded: false, activated: false };

  const stateEpoch = Number.isSafeInteger(state.sessionEpoch) ? state.sessionEpoch : 0;
  const pending = state.pendingCcSessionStarts;
  const canActivate = state.engine !== 'oc' && selectedSessionProvider(state) === 'codex' &&
    sameProfile === true && sameWorkspace === true &&
    state.activeProject === capturedProject &&
    Number.isSafeInteger(capturedEpoch) && stateEpoch === capturedEpoch &&
    !state.ccSessionId && !hasCodexSlot(state.parkedCcSessions) && !hasCodexSlot(pending);

  if (!canActivate) return { recorded: true, activated: false };

  state.ccSessionId = sessionId;
  return { recorded: true, activated: true };
}
