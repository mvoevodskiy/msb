/**
 * Boot restores project support/state without changing a valid conversation.
 * Old $4A107369–418; [contract](../../tests/reference/parity-projects-contract.txt).
 * [main](../main.mjs) calls once before polling; no mutable global process cwd.
 * [Checks](../../tests/project-restore.test.mjs). Existing user files/links stay.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadState,updateState,NO_STATE_WRITE} from '../state.mjs';
import {projectLocations,resolveProjectDirectory} from './paths.mjs';
import {applyProjectSelection} from './selection.mjs';

export async function prepareProjectSupport(env=process.env) {
  const {root,workspace}=projectLocations(env);
  await fs.mkdir(root,{recursive:true});
  const link=path.join(root,'CLAUDE.md');
  try { await fs.lstat(link);return; }
  catch(error) { if(error?.code!=='ENOENT')throw error; }
  try { await fs.symlink(path.join(workspace,'CLAUDE.md'),link); }
  catch(error) { if(error?.code!=='EEXIST')throw error; }
}
export async function restoreProjectState(env=process.env,{log=console.error}={}) {
  try { await prepareProjectSupport(env); }
  catch { log('[msb/projects] project support is unavailable'); }
  const {state}=await loadState(env);
  if(!state.activeProject)return {restored:false,cleared:false};
  try { await resolveProjectDirectory(state.activeProject,env);return {restored:true,cleared:false}; }
  catch(error) {
    if(error?.code!=='PROJECT_NOT_FOUND') {
      log('[msb/projects] saved project is unavailable; keeping its state');
      return {restored:false,cleared:false,unavailable:true};
    }
    let cleared=false;
    await updateState(current=>{
      if(current.activeProject!==state.activeProject || current.sessionEpoch!==state.sessionEpoch
        || current.ccSessionId!==state.ccSessionId)return NO_STATE_WRITE;
      cleared=true;return applyProjectSelection(current,undefined);
    },env);
    return {restored:false,cleared};
  }
}
