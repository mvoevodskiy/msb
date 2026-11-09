/**
 * Save the template key, then register it on the same owned local Gateway.
 * [Telegram form](../telegram/forms/mcp.mjs), [profile](../agent/openclaw-profile.mjs),
 * [native read](openclaw.mjs) and [ingress checks](../../tests/openclaw-mcp-setup.test.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readOpenClawOutput} from '../agent/openclaw-read.mjs';
import {ownedOpenClawProfile,openClawProfileEnvironment} from '../agent/openclaw-profile.mjs';
import {statePath} from '../paths.mjs';
import {loadState} from '../state.mjs';
import {selectedMcpProvider} from './catalog.mjs';
import {enrollMcpTemplate} from './managed.mjs';

const writes=new Map();
const localMode=['config','get','gateway.mode','--json'];
const gatewayConfig=['gateway','call','config.get','--json'];

async function readJson(args,options){
  const text=await readOpenClawOutput(args,options);
  try{return JSON.parse(text);}catch{return null;}
}

async function gatewaySnapshot(profile,options){
  const response=await readJson(gatewayConfig,options);
  if(typeof response?.path!=='string' || await fs.realpath(response.path).catch(()=>null)!==profile.file)return null;
  return response.config ?? null;
}

async function registerTemplate(template,value,captured,env){
  if(!captured)return false;
  const profile=await ownedOpenClawProfile(env);
  if(profile?.file!==captured.file || profile.state!==captured.state)return false;
  const options={env:openClawProfileEnvironment(env,profile),timeoutMs:30_000};
  if(await readJson(localMode,options)!=='local')return false;
  const before=await gatewaySnapshot(profile,options);
  if(!before || Object.hasOwn(before.mcp?.servers ?? {},template.name))return false;
  if(selectedMcpProvider((await loadState(env)).state)!=='oc')return false;
  const header=template.bearer?'Bearer '+value:value;
  const batch=[{path:'mcp.servers.'+template.name,
    value:{url:template.url,transport:'streamable-http',headers:{[template.header]:header}}}];
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'msb-oc-mcp-'));
  try{
    const file=path.join(temp,'registration.json');
    await fs.writeFile(file,JSON.stringify(batch),{mode:0o600});
    if(await readOpenClawOutput(['config','set','--batch-file',file],options)===null)return false;
    const after=await gatewaySnapshot(profile,options);
    const entry=after?.mcp?.servers?.[template.name];
    return entry?.url===template.url && entry?.transport==='streamable-http';
  }finally{
    await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});
  }
}

export function setupOpenClawTemplate({template,value,profile,env=process.env}){
  const scope=statePath(env),previous=writes.get(scope) ?? Promise.resolve();
  const current=previous.catch(()=>{}).then(async()=>{
    const saved=await enrollMcpTemplate({provider:'oc',name:template.name,value,env});
    if(!saved.ok)return saved;
    let ok=false;
    try{ok=await registerTemplate(template,value,profile,env);}catch{/* fixed failure text, no CLI credentials */}
    return {ok,keySaved:true};
  });
  writes.set(scope,current);
  const release=()=>{if(writes.get(scope)===current)writes.delete(scope);};
  current.then(release,release);
  return current;
}
