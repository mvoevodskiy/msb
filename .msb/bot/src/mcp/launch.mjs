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
import {claudeMcpPermission,readClaudeMcp} from './claude.mjs';

export async function prepareMcpLaunch(state,provider,env=process.env) {
  const templates=configuredMcpTemplates(state,provider);
  if(provider!=='claude' && !templates.length)return null;
  let directory,claudeLaunch=null;
  try {
    const native=provider==='claude'?await readClaudeMcp({env}):null;
    if(provider==='claude' && !native)return null;
    const nativeNames=new Set(native?.entries.map(row=>row.name));
    const claudeAllowedTools=[...nativeNames].map(claudeMcpPermission).filter(Boolean);
    if(claudeAllowedTools.length)claudeLaunch={claudeAllowedTools};
    if(!templates.length)return claudeLaunch;

    const {map}=await readEnvMap(env);
    const values={},selected=[];
    for(const template of templates){
      const value=map.get(template.key)?.trim();
      if(!value?.startsWith(template.prefix) || /\s/.test(value) || nativeNames.has(template.name))continue;
      selected.push(template);
      values[template.childKey]=value;
    }
    if(!selected.length)return claudeLaunch;
    if(provider==='codex')return {env:values,codexTemplates:selected.map(template=>template.name)};

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
    return {env:values,claudeConfig,claudeAllowedTools,close};
  }catch{
    if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});
    return claudeLaunch;
  }
}
