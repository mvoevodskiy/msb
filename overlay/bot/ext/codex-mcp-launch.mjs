/**
 * Captured, bot-owned template names -> Codex exec overrides with env references.
 * [Core handoff](../../../.msb/bot/src/mcp/launch.mjs), [runner](./adapters/codex.mjs),
 * [Bot-scoped names](../shared/codex-mcp-name.mjs), [read transport](./codex-app-read.mjs), [launch checks](../../../.msb/bot/tests/mcp-launch.test.mjs).
 */
import path from 'node:path';
import {mcpTemplate} from '../shared/mcp-templates.mjs';
import {codexManagedMcpName} from '../shared/codex-mcp-name.mjs';
import {isConfigObject} from '../shared/mcp-user-entries.mjs';
import {readCodexAppServer} from './codex-app-read.mjs';
import {codexMcpUserLayer} from './codex-mcp-layer.mjs';

export const CODEX_NATIVE_MCP_ERROR='Не удалось проверить отключённые MCP в выбранном профиле.';

function override(template,nativeName) {
  const url='url='+JSON.stringify(template.url);
  const env=JSON.stringify(template.childKey);
  const auth=template.bearer?'bearer_token_env_var='+env
    :'env_http_headers={'+JSON.stringify(template.header)+'='+env+'}';
  return 'mcp_servers.'+nativeName+'={'+url+','+auth+'}';
}

function nativeRemoval(raw) {
  const value=JSON.parse(raw);
  if(!isConfigObject(value) || typeof value.scope!=='string' || !path.isAbsolute(value.scope)
    || !Array.isArray(value.names)
    || !value.names.every(name=>typeof name==='string' && name))return null;
  return value;
}

function presentNativeServer(server) {
  return isConfigObject(server) && server.enabled!==false
    && (typeof server.url==='string' || typeof server.command==='string');
}

export async function prepareCodexMcp(command,cwd,env,{signal,ownProcessGroup=false}={}) {
  const hasRemoval=Boolean(env.MSB_TURN_MCP_REMOVE);
  if(!env.MSB_TURN_MCP_TEMPLATES && !hasRemoval)return {args:[],env};
  const names=new Set((env.MSB_TURN_MCP_TEMPLATES || '').split(','));
  const selected=[...names].map(mcpTemplate).filter(template=>template && env[template.childKey]);
  const childEnv={...env};
  delete childEnv.MSB_TURN_MCP_TEMPLATES;
  delete childEnv.MSB_TURN_MCP_REMOVE;
  for(const template of selected)delete childEnv[template.childKey];
  const empty={args:[],env:childEnv};
  if(!selected.length && !hasRemoval)return empty;

  const failed=hasRemoval?{...empty,blocked:true}:empty;
  let removal;
  if(hasRemoval){
    try{removal=nativeRemoval(env.MSB_TURN_MCP_REMOVE);}catch{return failed;}
    if(!removal)return failed;
  }
  // Normal turns own the preflight via the shim group. Compact owns its read separately.
  const result=await readCodexAppServer('config/read',{command,cwd,env:childEnv,signal,includeLayers:hasRemoval,ownProcessGroup});
  if(!result.ok || !isConfigObject(result.data?.config))return failed;
  const servers=result.data.config.mcp_servers ?? {};
  if(!isConfigObject(servers))return failed;

  const args=[];
  if(removal){
    const user=await codexMcpUserLayer(result.data,cwd,env);
    if(!user || user.scope!==removal.scope)return failed;
    const current=user.config.mcp_servers ?? {};
    if(!isConfigObject(current))return failed;
    const matches=[...new Set(removal.names)].filter(name=>Object.hasOwn(current,name) && Object.hasOwn(servers,name) && presentNativeServer(servers[name]));
    // A quoted table key preserves exact names and comes before managed entries.
    if(matches.length)args.push('-c','mcp_servers={'+matches.map(name=>JSON.stringify(name)+'={enabled=false}').join(',')+'}');
  }

  for(const template of selected) {
    const nativeName=codexManagedMcpName(template.name,env);
    if(Object.hasOwn(servers,nativeName))continue;
    childEnv[template.childKey]=env[template.childKey];
    args.push('-c',override(template,nativeName));
  }
  return {args,env:childEnv};
}
