/**
 * Enrollments in the current bot's state. Token values belong to [env store](../env/store.mjs).
 * [Telegram setup](../telegram/forms/mcp.mjs), [catalog routes](../telegram/routes/workspace.mjs),
 * [turn preparation](./launch.mjs), [owner/isolated scope checks](../../tests/mcp-setup.test.mjs).
 */
import {isConfigObject} from '../../shared/mcp-user-entries.mjs';
import {mcpTemplate} from '../../shared/mcp-templates.mjs';
import {codexManagedMcpName} from '../../shared/codex-mcp-name.mjs';
import {NO_STATE_WRITE,updateState} from '../state.mjs';
import {setEnvKey} from '../env/store.mjs';
import {statePath} from '../paths.mjs';
import {selectedMcpProvider} from './catalog.mjs';

export const supportsManagedMcp=provider=>provider==='claude' || provider==='codex';

const scopedEnvKey=(template,provider)=>template.key+'_'+provider.toUpperCase();

export function configuredMcpTemplates(state,provider) {
  const scoped=state.managedMcp?.[provider];
  if(!supportsManagedMcp(provider) || !isConfigObject(scoped))return [];
  const selected=[];
  for(const [name,record] of Object.entries(scoped)){
    const template=mcpTemplate(name);
    if(!template || record?.template!==name)continue;
    const key=record.key ?? template.key;
    if(key===template.key || key===scopedEnvKey(template,provider))selected.push({...template,key});
  }
  return selected;
}

export function managedMcpRows(state,provider,env=process.env) {
  const root=statePath(env);
  return configuredMcpTemplates(state,provider).map(({name})=>({
    name,root,managed:true,transport:'http',toolName:provider==='codex'?codexManagedMcpName(name,env):name,
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
    const collision=rows.has(row.name);
    rows.set(row.name,collision?{...row,status:'совпадает с сервером в профиле движка'}:row);
  }
  return {...catalog,entries:[...rows.values()]};
}

export async function enrollMcpTemplate({provider,name,value,env=process.env}) {
  const template=mcpTemplate(name);
  if(!supportsManagedMcp(provider) || !template)return {ok:false};
  let keySaved=false;
  try {
    await updateState(async state=>{
      if(selectedMcpProvider(state)!==provider)return NO_STATE_WRITE;
      const all=state.managedMcp ?? {},scoped=all[provider] ?? {};
      if(!isConfigObject(all) || !isConfigObject(scoped))throw new Error('Invalid MCP enrollment state');
      const own=configuredMcpTemplates(state,provider).find(item=>item.name===name);
      const other=provider==='claude'?'codex':'claude';
      const baseInUse=configuredMcpTemplates(state,other).some(item=>item.key===template.key);
      const key=baseInUse?scopedEnvKey(template,provider):own?.key ?? template.key;
      await setEnvKey(key,value,env);
      keySaved=true;
      state.managedMcp={...all,[provider]:{...scoped,[name]:{template:name,key}}};
      return state;
    },env);
    return keySaved?{ok:true}:{ok:false,providerChanged:true};
  }catch{return {ok:false,keySaved};}
}

export async function removeManagedMcpTemplate({provider,name,env=process.env}) {
  return updateState(state=>{
    if(selectedMcpProvider(state)!==provider || !configuredMcpTemplates(state,provider).some(item=>item.name===name))return NO_STATE_WRITE;
    const all={...state.managedMcp},scoped={...all[provider]};
    delete scoped[name];
    if(Object.keys(scoped).length)all[provider]=scoped;
    else delete all[provider];
    if(Object.keys(all).length)state.managedMcp=all;
    else delete state.managedMcp;
    return state;
  },env);
}
