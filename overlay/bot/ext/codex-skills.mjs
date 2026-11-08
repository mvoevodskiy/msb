/**
 * Selected Codex -> its native available skills for captured cwd, normalized for old core views.
 * [Read-only transport](./codex-skills-rpc.mjs), [core catalog](../../../.msb/bot/src/skills/catalog.mjs).
 * [Actual ingress checks](../../../.msb/bot/tests/skills-native.test.mjs); no login/install/config writes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {enrichPath} from './ensure-cli.mjs';
import {findBin} from './adapters/run-cli.mjs';
import {readCodexSkillList} from './codex-skills-rpc.mjs';
const scopes=new Set(['user','repo','system','admin']);
async function sameDirectory(a,b) {
  if(typeof a!=='string' || !path.isAbsolute(a))return false;
  if(path.resolve(a)===path.resolve(b))return true;
  try{return await fs.realpath(a)===await fs.realpath(b);}catch{return false;}
}
export async function listCodexSkills(snapshot,{cwd,env=process.env,signal,read=readCodexSkillList}={}) {
  if(snapshot.engine==='oc' || snapshot.extAuthBypass!=='codex' || env.JARVIS_CC_ONLY==='1' || signal?.aborted || typeof cwd!=='string' || !path.isAbsolute(cwd))return {ok:false};
  const childEnv={...env,PATH:enrichPath(env,env.HOME || os.homedir())};
  const command=findBin('codex',childEnv);if(!command)return {ok:false};
  const reply=await read({command,cwd,env:childEnv,signal});
  if(!reply.ok || !Array.isArray(reply.data?.data) || signal?.aborted)return {ok:false};
  const matching=[];
  for(const entry of reply.data.data)if(entry && await sameDirectory(entry.cwd,cwd))matching.push(entry);
  if(matching.length!==1 || !Array.isArray(matching[0].skills))return {ok:false};
  const entries=[];
  for(const skill of matching[0].skills) {
    if(!skill || typeof skill.name!=='string' || !skill.name.trim() || typeof skill.description!=='string'
      || typeof skill.path!=='string' || !path.isAbsolute(skill.path) || !scopes.has(skill.scope) || typeof skill.enabled!=='boolean')return {ok:false};
    let stat;try{stat=await fs.stat(skill.path);}catch{continue;}
    if(!stat.isFile())continue;
    entries.push({providerId:'codex',name:skill.name,description:skill.description,fullPath:skill.path,
      path:skill.path,root:skill.scope,source:skill.scope==='repo' && snapshot.activeProject?'project':'workspace',
      availability:skill.scope==='repo'?(snapshot.activeProject?'project':'workspace'):'global',
      disabled:!skill.enabled,type:skill.scope==='system'?'system':'user',size:stat.size});
  }
  return {ok:true,entries};
}
export function registerSkillsProvider(BotClass,env=process.env) {
  BotClass.prototype[Symbol.for('msb.skillsProvider')]=(snapshot,options={})=>
    listCodexSkills(snapshot,{...options,env:{...(options.env || process.env),...env}});
}
