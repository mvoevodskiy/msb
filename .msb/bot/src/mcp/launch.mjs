/**
 * Captured bot/provider -> launch metadata and dedicated credential env.
 * [Registry](./managed.mjs), [core runner](../agent/turn.mjs), [CLI argv/env](../agent/claude.mjs),
 * [Codex projection](../../../../overlay/bot/ext/codex-mcp-launch.mjs).
 * [Launch checks](../../tests/mcp-launch.test.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readEnvMap} from '../env/store.mjs';
import {configuredMcpTemplates} from './managed.mjs';
import {claudeNativeScope} from './native-removal.mjs';
import {codexNativeRemoval} from '../../shared/mcp-native-scope.mjs';
import {claudeMcpPermission} from './claude.mjs';

export async function prepareMcpLaunch(state,provider,env=process.env,cwd=process.cwd()) {
  if(provider!=='claude' && provider!=='codex')return null;
  const templates=configuredMcpTemplates(state,provider);
  let directory,base=null;
  try {
    const nativeNames=new Set(),claudeAllowedTools=[];
    if(provider==='claude') {
      const {native,scope,denied:claudeDeniedMcp}=await claudeNativeScope(state,cwd,env);
      const removed=new Set(claudeDeniedMcp);
      for(const {name} of native?.entries ?? [])if(!removed.has(name))nativeNames.add(name);
      claudeAllowedTools.push(...[...nativeNames].map(claudeMcpPermission).filter(Boolean));
      const claudeMcpScope=state.removedNativeMcp?.claude?scope:undefined;
      if(claudeAllowedTools.length || claudeMcpScope)base={claudeAllowedTools,claudeDeniedMcp,claudeMcpScope};
      if(!native)return base;
    }else{
      const removal=await codexNativeRemoval(state,cwd,env);
      if(removal)base={codexNativeRemoval:removal};
    }
    if(!templates.length)return base;

    const {map}=await readEnvMap(env);
    const values={},selected=[];
    for(const template of templates){
      const value=map.get(template.key)?.trim();
      if(!value?.startsWith(template.prefix) || /\s/.test(value) || nativeNames.has(template.name))continue;
      selected.push(template);
      values[template.childKey]=value;
    }
    if(!selected.length)return base;
    if(provider==='codex')return {...base,env:values,codexTemplates:selected.map(template=>template.name)};

    const mcpServers={};
    for(const template of selected){
      const variable='${'+template.childKey+'}';
      mcpServers[template.name]={
        type:'http',url:template.url,
        headers:{[template.header]:(template.bearer?'Bearer ':'')+variable},
      };
    }
    directory=await fs.mkdtemp(path.join(os.tmpdir(),'msb-mcp-'));
    const claudeConfig=path.join(directory,'config.json');
    await fs.writeFile(claudeConfig,JSON.stringify({mcpServers}),{mode:0o600});
    const close=()=>fs.rm(directory,{recursive:true,force:true}).catch(()=>{});
    claudeAllowedTools.push(...selected.map(template=>claudeMcpPermission(template.name)));
    // A valid bot-owned replacement takes the place of the hidden native name.
    const claudeDeniedMcp=base?.claudeDeniedMcp.filter(name=>!Object.hasOwn(mcpServers,name));
    return {...base,env:values,claudeConfig,claudeAllowedTools,claudeDeniedMcp,close};
  }catch{
    if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});
    return base;
  }
}
