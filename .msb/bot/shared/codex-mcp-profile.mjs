/**
 * Owned, per-invocation Codex profile handoff. The core owns cleanup,
 * the [Codex adapter](../../../overlay/bot/ext/codex-mcp-custom.mjs) publishes
 * the profile after checking native name collisions.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {codexMcpPath} from './mcp-native-scope.mjs';

const input=stage=>path.join(stage.directory,'servers.json');
const projection=stage=>path.join(stage.directory,'servers.config.toml');
const link=stage=>path.join(stage.home,stage.name+'.config.toml');
const nativeHome=(cwd,env)=>fs.realpath(path.dirname(codexMcpPath(cwd,env)));

export async function stageCodexMcp(servers,cwd,env) {
  const home=await nativeHome(cwd,env);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'msb-mcp-'));
  const stage={home,directory,name:'msb_mcp_'+randomUUID().replaceAll('-','')};
  const close=async()=>{
    if(await fs.readlink(link(stage)).catch(()=>null)===projection(stage))await fs.unlink(link(stage)).catch(()=>{});
    await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});
  };
  try{
    await fs.writeFile(input(stage),JSON.stringify(servers),{mode:0o600});
    return {codexCustom:stage,close};
  }catch(error){
    await close();
    throw error;
  }
}

export async function readStagedCodexMcp(raw,cwd,env) {
  const stage=JSON.parse(raw);
  if(typeof stage?.name!=='string' || !/^msb_mcp_[a-f0-9]{32}$/.test(stage.name)
    || typeof stage.directory!=='string' || !path.isAbsolute(stage.directory)
    || await nativeHome(cwd,env)!==stage.home)throw Error('Invalid MCP profile');
  const servers=JSON.parse(await fs.readFile(input(stage),'utf8'));
  if(!Array.isArray(servers))throw Error('Invalid MCP servers');
  return {stage,servers};
}

export async function publishCodexMcpProfile(stage,body) {
  await fs.writeFile(projection(stage),body,{mode:0o600,flag:'wx'});
  await fs.symlink(projection(stage),link(stage));
  return ['--profile',stage.name];
}
