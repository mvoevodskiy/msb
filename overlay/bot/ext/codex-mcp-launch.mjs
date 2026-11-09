/**
 * Captured, bot-owned template names -> Codex exec overrides with env references.
 * [Core handoff](../../../.msb/bot/src/mcp/launch.mjs), [runner](./adapters/codex.mjs),
 * [Bot-scoped names](../shared/codex-mcp-name.mjs), [read transport](./codex-app-read.mjs), [launch checks](../../../.msb/bot/tests/mcp-launch.test.mjs).
 */
import {mcpTemplate} from '../shared/mcp-templates.mjs';
import {codexManagedMcpName} from '../shared/codex-mcp-name.mjs';
import {isConfigObject} from '../shared/mcp-user-entries.mjs';
import {readCodexAppServer} from './codex-app-read.mjs';

function override(template,nativeName) {
  const url='url='+JSON.stringify(template.url);
  const env=JSON.stringify(template.childKey);
  const auth=template.bearer?'bearer_token_env_var='+env
    :'env_http_headers={'+JSON.stringify(template.header)+'='+env+'}';
  return 'mcp_servers.'+nativeName+'={'+url+','+auth+'}';
}

export async function prepareCodexMcp(command,cwd,env) {
  if(!env.MSB_TURN_MCP_TEMPLATES)return {args:[],env};
  const names=new Set(env.MSB_TURN_MCP_TEMPLATES.split(','));
  const selected=[...names].map(mcpTemplate).filter(template=>template && env[template.childKey]);
  const childEnv={...env};
  delete childEnv.MSB_TURN_MCP_TEMPLATES;
  for(const template of selected)delete childEnv[template.childKey];
  if(!selected.length)return {args:[],env:childEnv};

  // Native config can change after this read. Use a bot-scoped key even when
  // the normal service name is absent. An occupied reserved key is skipped.
  // This child belongs to the running turn's process group and stops with it.
  const result=await readCodexAppServer('config/read',{command,cwd,env:childEnv,includeLayers:false,ownProcessGroup:false});
  if(!result.ok || !isConfigObject(result.data?.config))return {args:[],env:childEnv};
  const servers=result.data.config.mcp_servers ?? {};
  if(!isConfigObject(servers))return {args:[],env:childEnv};

  const args=[];
  for(const template of selected) {
    const nativeName=codexManagedMcpName(template.name,env);
    if(Object.hasOwn(servers,nativeName))continue;
    childEnv[template.childKey]=env[template.childKey];
    args.push('-c',override(template,nativeName));
  }
  return {args,env:childEnv};
}
