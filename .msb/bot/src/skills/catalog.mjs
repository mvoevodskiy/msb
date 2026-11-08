/**
 * Captured provider/project -> read-only skills catalog; no cross-provider fallback.
 * [Claude reader](./claude-catalog.mjs), native adapters via bot msb.skillsProvider seam.
 * [Routes](../telegram/routes/skills.mjs), [provider checks](../../tests/skills-native.test.mjs).
 */
import {selectedSessionProvider} from '../../shared/session-starts.mjs';
import {projectLocations,resolveProjectCwd} from '../projects/paths.mjs';
import {readClaudeSkills} from './claude-catalog.mjs';

export async function skillCatalog(state,{env=process.env,readProvider,signal}={}) {
  if(state.engine==='oc')return {ok:false,kind:'oc',entries:[]};
  const provider=selectedSessionProvider(state);
  if(provider==='claude')return {ok:true,kind:'cli',entries:await readClaudeSkills(state,env)};
  if(!provider || !readProvider)return {ok:false,kind:'cli',entries:[]};
  try {
    const {workspace}=projectLocations(env),cwd=await resolveProjectCwd(state,env,workspace);
    const result=await readProvider(state,{env,cwd,workspace,signal});
    if(!result?.ok || !Array.isArray(result.entries))return {ok:false,kind:'cli',entries:[]};
    return {ok:true,kind:'cli',entries:result.entries};
  }catch{return {ok:false,kind:'cli',entries:[]};}
}
