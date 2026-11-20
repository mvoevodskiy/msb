/**
 * OpenClaw active slot -> the old bounded prior-ID list.
 * [Reset](selection.mjs), [named runner](../agent/openclaw-turn.mjs),
 * old SP 55416–55428 and bound My at 55682 in parity-openclaw-turn-contract.txt.
 */
export function clearOpenClawSession(state){
  const id=state.ocSessionId;
  if(typeof id==='string' && id){
    const previous=Array.isArray(state.ocPrevSessionIds)?state.ocPrevSessionIds:[];
    state.ocPrevSessionIds=[id,...previous.filter(value=>value!==id)].slice(0,3);
  }
  delete state.ocSessionId;
  delete state.ocSessionName;
  delete state.ocSessionProfile;
  delete state.ocFrameSessionId;
  delete state.ocContextTokens;
  delete state.ocContextSessionId;
  delete state.ocPendingJournalRestore;
}
