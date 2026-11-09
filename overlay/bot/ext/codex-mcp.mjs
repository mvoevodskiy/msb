/**
 * Selected Codex -> configured names/types from the native user layer. No auth/status
 * probes, project entries or raw config leave this provider. [Stdio](./codex-app-read.mjs),
 * [core](../../../.msb/bot/src/mcp/catalog.mjs), [protocol and UI](../../../.msb/bot/tests/mcp-catalog.test.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {enrichPath} from './ensure-cli.mjs';
import {findBin} from './adapters/run-cli.mjs';
import {readCodexAppServer} from './codex-app-read.mjs';
import {isConfigObject,mcpUserEntries} from '../shared/mcp-user-entries.mjs';

async function sameConfig(file,expected) {
  if(typeof file!=='string' || !path.isAbsolute(file))return false;
  if(path.resolve(file)===expected)return true;
  if(path.basename(file)!==path.basename(expected))return false;
  // Codex resolves symlinked CODEX_HOME even when config.toml is still absent.
  try{return await fs.realpath(path.dirname(file))===await fs.realpath(path.dirname(expected));}
  catch{return false;}
}

export async function listCodexMcp(snapshot,{cwd,env=process.env,signal}={}) {
  if(snapshot.engine==='oc' || snapshot.extAuthBypass!=='codex' || env.JARVIS_CC_ONLY==='1' || signal?.aborted
    || typeof cwd!=='string' || !path.isAbsolute(cwd))return null;
  const home=env.HOME || os.homedir();
  const root=path.resolve(cwd,env.CODEX_HOME || path.join(home,'.codex'),'config.toml');
  const childEnv={...env,PATH:enrichPath(env,home)};
  const command=findBin('codex',childEnv);
  if(!command)return null;
  const reply=await readCodexAppServer('config/read',{command,cwd,env:childEnv,signal});
  if(!reply.ok || signal?.aborted || !Array.isArray(reply.data?.layers))return null;
  const users=reply.data.layers.filter(layer=>layer?.name?.type==='user');
  if(users.length!==1 || !await sameConfig(users[0].name.file,root) || !isConfigObject(users[0].config))return null;
  const entries=mcpUserEntries(users[0].config.mcp_servers);
  return entries?{root,entries}:null;
}

export function registerMcpProvider(BotClass,env=process.env) {
  BotClass.prototype[Symbol.for('msb.mcpProvider')]=(snapshot,options={})=>
    listCodexMcp(snapshot,{...options,env:{...(options.env || process.env),...env}});
}
