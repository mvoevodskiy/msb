/**
 * Per-bot removal of a named entry inherited from one native user profile.
 * [Callback](../telegram/routes/workspace.mjs), [launch](./launch.mjs),
 * [scope checks](../../tests/mcp-native-remove.test.mjs).
 */
import {isConfigObject} from '../../shared/mcp-user-entries.mjs';
import {canonicalMcpPath,claudeMcpPath,removedNativeNames} from '../../shared/mcp-native-scope.mjs';
import {NO_STATE_WRITE,updateState} from '../state.mjs';
import {selectedMcpProvider} from './catalog.mjs';
import {readClaudeMcp} from './claude.mjs';

export async function claudeNativeScope(state,cwd,env) {
  const native=await readClaudeMcp({env,cwd});
  const scope=native?.scope ?? await canonicalMcpPath(claudeMcpPath(cwd,env));
  const removed=removedNativeNames(state,'claude',scope);
  if(!native)return {native,scope,denied:removed};
  const names=new Set(native.entries.map(row=>row.name));
  return {native,scope,denied:removed.filter(name=>names.has(name))};
}

export function visibleNativeMcp(catalog,state) {
  const removed=new Set(removedNativeNames(state,catalog.provider,catalog.scope));
  if(!removed.size)return catalog;
  return {...catalog,entries:catalog.entries.filter(row=>!removed.has(row.name))};
}

export function recordNativeMcpRemoval(state,{provider,scope,name}) {
  const names=removedNativeNames(state,provider,scope);
  if(names.includes(name))return false;
  const all=state.removedNativeMcp ?? {},profiles=all[provider] ?? {};
  if(!isConfigObject(all) || !isConfigObject(profiles))throw new Error('Invalid native MCP removal state');
  state.removedNativeMcp={...all,[provider]:{...profiles,[scope]:[...names,name]}};
  return true;
}

export function removeInheritedMcp({provider,scope,name,env=process.env}) {
  return updateState(state=>{
    if(selectedMcpProvider(state)!==provider)return NO_STATE_WRITE;
    return recordNativeMcpRemoval(state,{provider,scope,name})?state:NO_STATE_WRITE;
  },env);
}
