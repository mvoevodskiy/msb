/**
 * Native result -> one serialized active/parked ID, usage and description update.
 * [Turn](./turn.mjs) owns I/O and captured state; [ledger](../sessions/ledger.mjs) owns metadata.
 * [First-start placement](../../shared/session-starts.mjs) preserves provider switches,
 * while reset/selector/project epoch fences reject old results. No native files deleted.
 * [Runner checks](../../tests/session-ledger.test.mjs), [first starts](../../tests/first-session.test.mjs).
 */
import {NO_STATE_WRITE} from '../state.mjs';
import {completeFirstSession,isProviderSession,selectedSessionProvider} from '../../shared/session-starts.mjs';
import {recordSessionMetadata} from '../sessions/ledger.mjs';

export function applySessionResult(state,{snapshot,reservation,result,prompt,signal}) {
  const successful=!result.isError && !result.aborted && !signal?.aborted;
  const sameTurn=state.ccSessionId===snapshot.ccSessionId
    && (state.sessionEpoch || 0)===(snapshot.sessionEpoch || 0)
    && state.extAuthBypass===snapshot.extAuthBypass && state.activeProject===snapshot.activeProject;
  const usage=()=>({...result.usage,...result.context,model:result.model,
    sessionId:result.sessionId,updatedAt:new Date().toISOString()});
  if(reservation) {
    if(!successful){result.context=null;return NO_STATE_WRITE;}
    const placement=completeFirstSession(state,reservation,result);
    if(placement!=='active' || !sameTurn)result.context=null;
    if(placement==='active' && sameTurn)state.lastCcUsage=usage();
    if(placement)recordSessionMetadata(state,{id:result.sessionId,providerId:reservation.provider,
      project:snapshot.activeProject,prompt});
    return state;
  }
  const provider=selectedSessionProvider(snapshot);
  const ownsResult=(!result.providerId || result.providerId===provider) && isProviderSession(result.sessionId,provider);
  if(!sameTurn || !ownsResult){result.context=null;return NO_STATE_WRITE;}
  if(successful) {
    state.ccSessionId=result.sessionId;
    state.lastCcUsage=usage();
  } else {
    // Old counts described returned attempts, not only successes. A failed/aborted
    // attempt can update metadata only for the unchanged ID already owned before it.
    if(result.sessionId!==snapshot.ccSessionId){result.context=null;return NO_STATE_WRITE;}
    result.context=null;
  }
  recordSessionMetadata(state,{id:result.sessionId,providerId:provider,project:snapshot.activeProject,prompt});
  return state;
}
