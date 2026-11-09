/**
 * Selected Codex -> configured names/types from the native user layer. No auth/status
 * probes, project entries or raw config leave this provider. [Stdio](./codex-app-read.mjs),
 * [core](../../../.msb/bot/src/mcp/catalog.mjs), [protocol and UI](../../../.msb/bot/tests/mcp-catalog.test.mjs).
 */
import os from 'node:os';
import path from 'node:path';
import {enrichPath} from './ensure-cli.mjs';
import {findBin} from './adapters/run-cli.mjs';
import {readCodexAppServer} from './codex-app-read.mjs';
import {mcpUserEntries} from '../shared/mcp-user-entries.mjs';
import {codexMcpUserLayer} from './codex-mcp-layer.mjs';
import {canonicalMcpPath,codexMcpPath} from '../shared/mcp-native-scope.mjs';

export async function listCodexMcp(snapshot,{cwd,env=process.env,signal}={}) {
  if(snapshot.engine==='oc' || snapshot.extAuthBypass!=='codex' || env.JARVIS_CC_ONLY==='1' || signal?.aborted
    || typeof cwd!=='string' || !path.isAbsolute(cwd))return null;
  const home=env.HOME || os.homedir();
  const childEnv={...env,PATH:enrichPath(env,home)};
  const command=findBin('codex',childEnv);
  if(!command)return null;
  const scope=await canonicalMcpPath(codexMcpPath(cwd,env));
  if(signal?.aborted)return null;
  const reply=await readCodexAppServer('config/read',{command,cwd,env:childEnv,signal});
  if(!reply.ok || signal?.aborted)return null;
  const layer=await codexMcpUserLayer(reply.data,cwd,env);
  if(!layer || layer.scope!==scope || signal?.aborted)return null;
  const entries=mcpUserEntries(layer.config.mcp_servers);
  return entries?{root:layer.root,scope:layer.scope,entries}:null;
}

export function registerMcpProvider(BotClass,env=process.env) {
  BotClass.prototype[Symbol.for('msb.mcpProvider')]=(snapshot,options={})=>
    listCodexMcp(snapshot,{...options,env:{...(options.env || process.env),...env}});
}
