/**
 * Native result -> one serialized history and guarded active/parked ID/usage update.
 * [Turn](./turn.mjs) owns I/O and captured state; [ledger](../sessions/ledger.mjs) owns metadata.
 * History counts actual returned attempts independently of automatic activation.
 * [First-start placement](../../shared/session-starts.mjs) preserves provider switches;
 * reset/selector/project fences still reject stale active IDs, usage and context.
 * Old Claude refused resume → retire the matching slot and reserve its one retry.
 * [Runner checks](../../tests/session-ledger.test.mjs), [first starts](../../tests/first-session.test.mjs),
 * [recovery](../../tests/claude-resume-recovery.test.mjs).
 */
import {NO_STATE_WRITE,updateState} from '../state.mjs';
import {claimFirstSession,completeFirstSession,isProviderSession,selectedSessionProvider} from '../../shared/session-starts.mjs';
import {recordSessionMetadata} from '../sessions/ledger.mjs';

function sameConversation(state, snapshot) {
  return state.ccSessionId === snapshot.ccSessionId &&
    (state.sessionEpoch || 0) === (snapshot.sessionEpoch || 0) &&
    state.extAuthBypass === snapshot.extAuthBypass && state.activeProject === snapshot.activeProject;
}

export async function beginClaudeResumeRecovery(snapshot, env, signal) {
  let reservation;
  const state = await updateState(current => {
    if (signal?.aborted || current.engine === 'oc' || selectedSessionProvider(current) !== 'claude' ||
        !sameConversation(current, snapshot)) return NO_STATE_WRITE;
    delete current.ccSessionId;
    if (current.lastCcUsage?.sessionId === snapshot.ccSessionId) delete current.lastCcUsage;
    current.sessionEpoch = (Number.isSafeInteger(current.sessionEpoch) ? current.sessionEpoch : 0) + 1;
    reservation = claimFirstSession(current, 'claude');
    return current;
  }, env);
  return reservation ? { state, reservation } : null;
}

export function applySessionResult(state,{snapshot,reservation,result,prompt,signal}) {
  const provider=reservation?.provider || selectedSessionProvider(snapshot);
  const ownsResult=(!result.providerId || result.providerId===provider) && isProviderSession(result.sessionId,provider);
  // Old tE counted returned passes, including first error/abort and late results.
  // A carried known resume ID counts after launch; an early pre-spawn return does not.
  const returnedAttempt=result.spawned===true && (result.sessionIdObserved===true
    || (result.sessionId===snapshot.ccSessionId && isProviderSession(snapshot.ccSessionId,provider)));
  const recorded=ownsResult && returnedAttempt && recordSessionMetadata(state,{id:result.sessionId,
    providerId:provider,project:snapshot.activeProject,prompt});
  const historyOnly=()=>recorded?state:NO_STATE_WRITE;
  const successful=!result.isError && !result.aborted && !signal?.aborted;
  const sameTurn=sameConversation(state,snapshot);
  const usage=()=>({...result.usage,...result.context,model:result.model,
    sessionId:result.sessionId,updatedAt:new Date().toISOString()});
  if(reservation) {
    if(!successful){result.context=null;return historyOnly();}
    const placement=completeFirstSession(state,reservation,result);
    if(placement!=='active' || !sameTurn)result.context=null;
    if(placement==='active' && sameTurn)state.lastCcUsage=usage();
    return state;
  }
  if(!sameTurn || !ownsResult){result.context=null;return historyOnly();}
  if(successful) {
    state.ccSessionId=result.sessionId;
    state.lastCcUsage=usage();
    return state;
  }
  // Failure/abort may retain historical metadata; it never replaces active state/usage.
  result.context=null;
  return historyOnly();
}
