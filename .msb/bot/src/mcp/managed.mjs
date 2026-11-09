/**
 * Enrollments in the current bot's state. Templates use [env store](../env/store.mjs).
 * ADD_MCP definitions stay in [private files](custom-config.mjs).
 * [Telegram setup](../telegram/forms/mcp.mjs), [catalog routes](../telegram/routes/workspace.mjs),
 * [turn preparation](./launch.mjs), [owner/isolated scope checks](../../tests/mcp-setup.test.mjs).
 */
import {isConfigObject} from '../../shared/mcp-user-entries.mjs';
import {mcpTemplate} from '../../shared/mcp-templates.mjs';
import {codexManagedMcpName} from '../../shared/codex-mcp-name.mjs';
import {NO_STATE_WRITE,updateState} from '../state.mjs';
import {setEnvKey} from '../env/store.mjs';
import profile from '../../shared/profile.cjs';
import {botId,statePath} from '../paths.mjs';
import {isCustomMcpName} from './install-protocol.mjs';
import {createCustomMcpConfig,isCustomMcpRecord,readCustomMcpConfig,retireCustomMcpConfig} from './custom-config.mjs';
import {selectedMcpProvider} from './catalog.mjs';
import {recordNativeMcpRemoval} from './native-removal.mjs';

export const supportsManagedMcp=provider=>provider==='claude' || provider==='codex';
export const supportsMcpTemplate=provider=>provider==='oc' || supportsManagedMcp(provider);
const templateProviders=['claude','codex','oc'];

const scopedEnvKey=(template,provider)=>template.key+'_'+provider.toUpperCase();

function managedRecords(state,provider) {
  const scoped=state.managedMcp?.[provider];
  return supportsMcpTemplate(provider) && isConfigObject(scoped)?Object.entries(scoped):[];
}

function customRecords(state,provider) {
  if(!supportsManagedMcp(provider))return [];
  return managedRecords(state,provider).filter(([name,record])=>isCustomMcpName(name) && isCustomMcpRecord(record));
}

export async function configuredCustomMcp(state,provider,env) {
  const entries=await Promise.all(customRecords(state,provider).map(([name,record])=>readCustomMcpConfig(name,record,env)));
  return entries.filter(Boolean);
}

export function configuredMcpTemplates(state,provider) {
  const selected=[];
  for(const [name,record] of managedRecords(state,provider)){
    const template=mcpTemplate(name);
    if(!template || record?.template!==name)continue;
    const key=record.key ?? template.key;
    if(key===template.key || key===scopedEnvKey(template,provider))selected.push({...template,key});
  }
  return selected;
}

export function managedMcpRows(state,provider,env=process.env) {
  // An OpenClaw key reference does not establish a native registration.
  if(!supportsManagedMcp(provider))return [];
  const root=statePath(env);
  const templates=configuredMcpTemplates(state,provider).map(({name})=>({name,transport:'http'}));
  const custom=customRecords(state,provider).map(([name,{transport}])=>({name,transport,replacesNative:true}));
  return [...templates,...custom].map(row=>({
    ...row,root,managed:true,toolName:provider==='codex'?codexManagedMcpName(row.name,env):row.name,
  }));
}

export function includeManagedMcp(catalog,state,env=process.env) {
  const owned=managedMcpRows(state,catalog.provider,env);
  if(!owned.length)return catalog;
  if(catalog.provider==='codex') {
    const names=new Set(catalog.entries.map(row=>row.name));
    const managed=owned.map(row=>({
      ...row,
      ...(names.has(row.name)?{label:row.name+' (бот)'}:{}),
      ...(names.has(row.toolName)?{status:'совпадает с сервером в профиле движка'}:{}),
    }));
    return {...catalog,entries:[...catalog.entries,...managed]};
  }
  const rows=new Map(catalog.entries.map(row=>[row.name,row]));
  for(const row of owned) {
    const collision=rows.has(row.name) && !row.replacesNative;
    rows.set(row.name,collision?{...row,status:'совпадает с сервером в профиле движка'}:row);
  }
  return {...catalog,entries:[...rows.values()]};
}

function setRecord(state,provider,name,record) {
  const all=state.managedMcp ?? {},existing=all[provider] ?? {};
  if(!isConfigObject(all) || !isConfigObject(existing))throw Error('Invalid MCP enrollment state');
  const next={...all},scoped={...existing};
  if(record)scoped[name]=record;
  else delete scoped[name];
  if(Object.keys(scoped).length)next[provider]=scoped;
  else delete next[provider];
  if(Object.keys(next).length)state.managedMcp=next;
  else delete state.managedMcp;
  return state;
}

export function captureMcpInstallTarget(state,env) {
  const provider=selectedMcpProvider(state);
  if(!supportsManagedMcp(provider))return null;
  const {id,root}=profile.resolveProfile(env);
  const scoped=Object.freeze({MSB_RUNTIME_PROFILE:id,MSB_RUNTIME_ROOT:root,MSB_BOT_ID:botId(env)});
  return Object.freeze({provider,env:scoped});
}

export async function enrollCustomMcp({name,config},target,{signal,replaceScope}={}) {
  if(!target?.env || !supportsManagedMcp(target.provider) || !isCustomMcpName(name))throw Error('Unsupported MCP target');
  const {provider,env}=target;
  let written,previous;
  try{
    await updateState(async state=>{
      signal?.throwIfAborted();
      written=await createCustomMcpConfig(config,env);
      signal?.throwIfAborted();
      previous=state.managedMcp?.[provider]?.[name];
      if(replaceScope)recordNativeMcpRemoval(state,{provider,scope:replaceScope,name});
      return setRecord(state,provider,name,written);
    },env,{signal});
  }catch(error){
    await retireCustomMcpConfig(written,env);
    throw error;
  }
  await retireCustomMcpConfig(previous,env);
}

export async function enrollMcpTemplate({provider,name,value,env=process.env}) {
  const template=mcpTemplate(name);
  if(!supportsMcpTemplate(provider) || !template)return {ok:false};
  let keySaved=false,previous;
  try {
    await updateState(async state=>{
      if(selectedMcpProvider(state)!==provider)return NO_STATE_WRITE;
      previous=state.managedMcp?.[provider]?.[name];
      const own=configuredMcpTemplates(state,provider).find(item=>item.name===name);
      const baseInUse=templateProviders.some(other=>other!==provider
        && configuredMcpTemplates(state,other).some(item=>item.key===template.key));
      const key=baseInUse?scopedEnvKey(template,provider):own?.key ?? template.key;
      const next=setRecord(state,provider,name,{template:name,key});
      await setEnvKey(key,value,env);
      keySaved=true;
      return next;
    },env);
    if(keySaved)await retireCustomMcpConfig(previous,env);
    return keySaved?{ok:true}:{ok:false,providerChanged:true};
  }catch{return {ok:false,keySaved};}
}

export async function removeManagedMcp({provider,name,env=process.env}) {
  let previous;
  const updated=await updateState(state=>{
    if(selectedMcpProvider(state)!==provider || !managedMcpRows(state,provider,env).some(row=>row.name===name))return NO_STATE_WRITE;
    previous=state.managedMcp[provider][name];
    return setRecord(state,provider,name,null);
  },env);
  await retireCustomMcpConfig(previous,env);
  return updated;
}
