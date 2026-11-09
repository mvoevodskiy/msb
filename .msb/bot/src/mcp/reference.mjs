/**
 * MCP server identity -> bounded callback for one provider/config file.
 * [Codec](../../shared/callback-ref.mjs), [route](../telegram/routes/workspace.mjs),
 * [stale provider and UTF-8 checks](../../tests/mcp-catalog.test.mjs).
 */
import {nameReference,resolveNameReference} from '../../shared/callback-ref.mjs';

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
