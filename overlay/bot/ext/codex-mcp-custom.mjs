/**
 * Old ADD_MCP definitions -> a private native Codex profile layer.
 * [Preflight](./codex-mcp-launch.mjs) passes the effective config for collision
 * checks. [Core handoff](../shared/codex-mcp-profile.mjs) owns cleanup.
 */
import {codexManagedMcpName} from '../shared/codex-mcp-name.mjs';
import {publishCodexMcpProfile,readStagedCodexMcp} from '../shared/codex-mcp-profile.mjs';

const quoted=value=>JSON.stringify(value.toWellFormed())
  .replace(/[\u007f-\u009f]/g,character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));

function serverTable(name,config) {
  const heading='[mcp_servers.'+quoted(name)+']';
  if(config.type==='stdio'){
    const args=config.args?.map(quoted).join(', ');
    return [heading,'command = '+quoted(config.command),...(args===undefined?[]:['args = ['+args+']'])].join('\n');
  }
  const headers=Object.entries(config.headers ?? {}).map(([key,value])=>quoted(key)+' = '+quoted(value));
  return [heading,'url = '+quoted(config.url),...(headers.length?['http_headers = { '+headers.join(', ')+' }']:[])].join('\n');
}

export async function prepareCodexCustomMcp(raw,cwd,env,nativeServers) {
  const {stage,servers}=await readStagedCodexMcp(raw,cwd,env);
  const tables=[];
  for(const {name,config} of servers){
    const alias=codexManagedMcpName(name,env);
    if(!Object.hasOwn(nativeServers,alias))tables.push(serverTable(alias,config));
  }
  return tables.length?publishCodexMcpProfile(stage,tables.join('\n\n')+'\n'):[];
}
