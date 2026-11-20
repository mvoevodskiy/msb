/**
 * Match the native user layer to the physical config identity for this invocation.
 * Callers: [MCP catalog](./codex-mcp.mjs), [MCP launch](./codex-mcp-launch.mjs).
 */
import path from 'node:path';
import {isConfigObject} from '../shared/mcp-user-entries.mjs';
import {canonicalMcpPath,codexMcpPath} from '../shared/mcp-native-scope.mjs';

export async function codexMcpUserLayer(data,cwd,env) {
  if(!Array.isArray(data?.layers))return null;
  const users=data.layers.filter(layer=>layer?.name?.type==='user');
  if(users.length!==1 || !isConfigObject(users[0].config))return null;
  const file=users[0].name.file;
  if(typeof file!=='string' || !path.isAbsolute(file))return null;
  const root=codexMcpPath(cwd,env),scope=await canonicalMcpPath(root);
  if(await canonicalMcpPath(file)!==scope)return null;
  return {root,scope,config:users[0].config};
}
