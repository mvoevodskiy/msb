/**
 * MCP server identity -> bounded callback for one provider/config file.
 * [Codec](../../shared/callback-ref.mjs), [route](../telegram/routes/workspace.mjs),
 * [stale provider and UTF-8 checks](../../tests/mcp-catalog.test.mjs).
 */
import {nameReference,resolveNameReference} from '../../shared/callback-ref.mjs';

const options={marker:'m~',actionPrefix:'mcp:server:',maxLiteralChars:0};
const identity=(catalog,name)=>JSON.stringify([catalog.provider,catalog.root,name]);

export function mcpReference(catalog,name) {
  return nameReference(identity(catalog,name),options);
}

export function resolveMcpReference(reference,catalog) {
  if(reference.startsWith(options.marker)) {
    const match=resolveNameReference(reference,catalog.entries.map(row=>identity(catalog,row.name)),options);
    return catalog.entries.find(row=>identity(catalog,row.name)===match);
  }
  // Old buttons carry a raw name and belonged to the Claude workspace.
  if(catalog.provider==='claude')return catalog.entries.find(row=>row.name===reference);
}
