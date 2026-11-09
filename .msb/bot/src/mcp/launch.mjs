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
import {configuredCustomMcp,configuredMcpTemplates} from './managed.mjs';
import {claudeNativeScope} from './native-removal.mjs';
import {codexNativeRemoval} from '../../shared/mcp-native-scope.mjs';
import {stageCodexMcp} from '../../shared/codex-mcp-profile.mjs';
import {claudeMcpPermission} from './claude.mjs';

export async function prepareMcpLaunch(state,provider,env=process.env,cwd=process.cwd()) {
  if(provider!=='claude' && provider!=='codex')return null;
  const templates=configuredMcpTemplates(state,provider);
  const custom=await configuredCustomMcp(state,provider,env);
  let directory,base=null,canLoadTemplates=true;
  try {
    const nativeNames=new Set(),claudeAllowedTools=[];
    if(provider==='claude') {
      const {native,scope,denied:claudeDeniedMcp}=await claudeNativeScope(state,cwd,env);
      const removed=new Set(claudeDeniedMcp);
      for(const {name} of native?.entries ?? [])if(!removed.has(name))nativeNames.add(name);
      claudeAllowedTools.push(...[...nativeNames].map(claudeMcpPermission).filter(Boolean));
      const claudeMcpScope=state.removedNativeMcp?.claude?scope:undefined;
      if(claudeAllowedTools.length || claudeMcpScope)base={claudeAllowedTools,claudeDeniedMcp,claudeMcpScope};
      canLoadTemplates=Boolean(native);
      if(!native && !custom.length)return base;
    }else{
      const removal=await codexNativeRemoval(state,cwd,env);
      if(removal)base={codexNativeRemoval:removal};
    }
    if(!templates.length && !custom.length)return base;

    const map=templates.length && canLoadTemplates?(await readEnvMap(env).catch(()=>null))?.map:null;
    const values={},selected=[];
    for(const template of templates){
      const value=map?.get(template.key)?.trim();
      if(!value?.startsWith(template.prefix) || /\s/.test(value) || nativeNames.has(template.name))continue;
      selected.push(template);
      values[template.childKey]=value;
    }
    if(!selected.length && !custom.length)return base;
    if(provider==='codex'){
      const profile=custom.length?await stageCodexMcp(custom,cwd,env):null;
      return {...base,...profile,env:values,codexTemplates:selected.map(template=>template.name)};
    }

    const mcpServers=Object.fromEntries(custom.map(({name,config})=>[name,config]));
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
    const allowed=[...new Set([...claudeAllowedTools,...Object.keys(mcpServers).map(claudeMcpPermission).filter(Boolean)])];
    // A valid bot-owned replacement takes the place of the hidden native name.
    const claudeDeniedMcp=base?.claudeDeniedMcp.filter(name=>!Object.hasOwn(mcpServers,name));
    return {...base,env:values,claudeConfig,claudeAllowedTools:allowed,claudeDeniedMcp,close};
  }catch{
    if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});
    if(custom.length)throw Error('Не удалось загрузить MCP выбранного бота.');
    return base;
  }
}
