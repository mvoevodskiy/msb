/**
 * Captured, bot-owned template names -> Codex exec overrides with env references.
 * [Core handoff](../../../.msb/bot/src/mcp/launch.mjs), [runner](./adapters/codex.mjs),
 * [read transport](./codex-app-read.mjs), [launch checks](../../../.msb/bot/tests/mcp-launch.test.mjs).
 */
import {mcpTemplate} from '../shared/mcp-templates.mjs';
import {isConfigObject} from '../shared/mcp-user-entries.mjs';
import {readCodexAppServer} from './codex-app-read.mjs';

function override(template) {
  const url='url='+JSON.stringify(template.url);
  const env=JSON.stringify(template.childKey);
  const auth=template.bearer?'bearer_token_env_var='+env
    :'env_http_headers={'+JSON.stringify(template.header)+'='+env+'}';
  return 'mcp_servers.'+template.name+'={'+url+','+auth+'}';
}

export async function prepareCodexMcp(command,cwd,env) {
  if(!env.MSB_TURN_MCP_TEMPLATES)return {args:[],env};
  const names=new Set(env.MSB_TURN_MCP_TEMPLATES.split(','));
  const selected=[...names].map(mcpTemplate).filter(template=>template && env[template.childKey]);
  const childEnv={...env};
  delete childEnv.MSB_TURN_MCP_TEMPLATES;
  for(const template of selected)delete childEnv[template.childKey];
  if(!selected.length)return {args:[],env:childEnv};

  // Native table overrides merge lower-layer headers. Skip every conflicting name.
  // This child belongs to the running turn's process group and stops with it.
  const result=await readCodexAppServer('config/read',{command,cwd,env:childEnv,includeLayers:false,ownProcessGroup:false});
  if(!result.ok || !isConfigObject(result.data?.config))return {args:[],env:childEnv};
  const servers=result.data.config.mcp_servers ?? {};
  if(!isConfigObject(servers))return {args:[],env:childEnv};

  const args=[];
  for(const template of selected) {
    if(Object.hasOwn(servers,template.name))continue;
    childEnv[template.childKey]=env[template.childKey];
    args.push('-c',override(template));
  }
  return {args,env:childEnv};
}
