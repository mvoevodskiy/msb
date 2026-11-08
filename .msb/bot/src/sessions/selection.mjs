/**
 * Saved row callback -> validated project + ID in one [state](../state.mjs) transaction.
 * [Scope](./scope.mjs) owns provider identity; [project reset](../projects/selection.mjs)
 * cancels all old-cwd slots only on a project transition. No native auth/history I/O.
 * [Routes](../telegram/routes/sessions.mjs), [checks](../../tests/sessions.test.mjs).
 */
import {loadState,updateState,NO_STATE_WRITE} from '../state.mjs';
import {invalidateFirstSession} from '../../shared/session-starts.mjs';
import {applyProjectSelection} from '../projects/selection.mjs';
import {resolveProjectDirectory} from '../projects/paths.mjs';
import {cliSessionEntries,historyProvider} from './scope.mjs';
import {resolveSessionReference} from './callback-key.mjs';
const project=row=>row.project || undefined;
const epoch=state=>state.sessionEpoch || 0;
function clearParkedProvider(state,provider) {
  const slots=state.parkedCcSessions;
  if(!slots || typeof slots!=='object' || Array.isArray(slots) || !Object.hasOwn(slots,provider))return;
  const next={...slots};delete next[provider];
  if(Object.keys(next).length)state.parkedCcSessions=next;else delete state.parkedCcSessions;
}
export function resetCliConversation(env=process.env) {
  return updateState(state=>{
    invalidateFirstSession(state);delete state.ccSessionId;
    state.sessionEpoch=(Number.isSafeInteger(state.sessionEpoch)?state.sessionEpoch:0)+1;
    return state;
  },env);
}
export async function selectSavedSession(reference,env=process.env) {
  const {state:snapshot}=await loadState(env),provider=historyProvider(snapshot,env);
  const entries=cliSessionEntries(snapshot,env),id=resolveSessionReference(reference,entries.map(row=>row.id));
  const matches=entries.filter(row=>row.id===id);
  if(!provider || matches.length!==1)return null;
  const chosen=matches[0],targetProject=project(chosen);
  if(targetProject)await resolveProjectDirectory(targetProject,env);
  let selected=null;
  await updateState(state=>{
    if(historyProvider(state,env)!==provider || state.engine!==snapshot.engine || epoch(state)!==epoch(snapshot))return NO_STATE_WRITE;
    const current=cliSessionEntries(state,env).filter(row=>row.id===id);
    if(current.length!==1 || project(current[0])!==targetProject)return NO_STATE_WRITE;
    if((state.activeProject || undefined)!==targetProject)applyProjectSelection(state,targetProject);
    else {
      invalidateFirstSession(state);clearParkedProvider(state,provider);delete state.lastCcUsage;
      state.sessionEpoch=(Number.isSafeInteger(state.sessionEpoch)?state.sessionEpoch:0)+1;
    }
    state.ccSessionId=id;selected={...current[0]};return state;
  },env);
  return selected;
}
