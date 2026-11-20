/**
 * Captured provider/project -> read-only skills catalog; no cross-provider fallback.
 * [Claude reader](./claude-catalog.mjs), [OC reader](./openclaw.mjs), native CLI adapters via msb.skillsProvider.
 * [Routes](../telegram/routes/skills.mjs), [provider checks](../../tests/skills-native.test.mjs).
 */
import {selectedSessionProvider} from '../../shared/session-starts.mjs';
import {projectLocations,resolveProjectCwd} from '../projects/paths.mjs';
import {readClaudeSkills} from './claude-catalog.mjs';
import {readOpenClawSkills} from './openclaw.mjs';

export async function skillCatalog(state,{env=process.env,readProvider,readOpenClaw=readOpenClawSkills,signal}={}) {
  if(state.engine==='oc') {
    let skills;try{skills=await readOpenClaw({env,signal});}catch{skills=[];}
    return {ok:Array.isArray(skills)&&skills.length>0,kind:'oc',skills:Array.isArray(skills)?skills:[],entries:[]};
  }
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
