/**
 * MCP server identity -> bounded callback for one provider/config file.
 * [Codec](../../shared/callback-ref.mjs), [route](../telegram/routes/workspace.mjs),
 * [stale provider and UTF-8 checks](../../tests/mcp-catalog.test.mjs).
 */
import {nameReference,resolveNameReference} from '../../shared/callback-ref.mjs';
import {statePath} from '../paths.mjs';

const options={marker:'m~',actionPrefix:'mcp:server:',maxLiteralChars:0};
const identity=(catalog,row)=>JSON.stringify([catalog.provider,row.root ?? catalog.root,row.name]);

export function mcpReference(catalog,row) {
  return nameReference(identity(catalog,row),options);
}

export function resolveMcpReference(reference,catalog) {
  if(reference.startsWith(options.marker)) {
    const match=resolveNameReference(reference,catalog.entries.map(row=>identity(catalog,row)),options);
    return catalog.entries.find(row=>identity(catalog,row)===match);
  }
  // Old buttons carry a raw name and belonged to the Claude workspace.
  if(catalog.provider==='claude')return catalog.entries.find(row=>!row.managed && row.name===reference);
}

const deleteOptions={marker:'d~',actionPrefix:'mcp:delete:',maxLiteralChars:0};
const deleteIdentity=(catalog,row,env)=>JSON.stringify([statePath(env),catalog.provider,catalog.scope,row.name]);
export const isNativeMcpDeleteReference=reference=>reference.startsWith(deleteOptions.marker);

export function mcpDeleteReference(catalog,row,env=process.env) {
  if(row.managed)return mcpReference(catalog,row);
  if(catalog.scope)return nameReference(deleteIdentity(catalog,row,env),deleteOptions);
}

export function resolveNativeMcpDeleteReference(reference,catalog,env=process.env) {
  if(!catalog.scope || !isNativeMcpDeleteReference(reference))return;
  const names=catalog.entries.map(row=>deleteIdentity(catalog,row,env));
  const match=resolveNameReference(reference,names,deleteOptions);
  return catalog.entries.find(row=>deleteIdentity(catalog,row,env)===match);
}
