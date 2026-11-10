/**
 * Configured name and transport only. Callers: [Claude](../src/mcp/claude.mjs)
 * and [Codex](../../../overlay/bot/ext/codex-mcp.mjs). Never expose a server definition to the menu.
 * [Configured row and secret exclusion checks](../tests/mcp-catalog.test.mjs).
 */
export const isConfigObject=value=>value!==null && typeof value==='object' && !Array.isArray(value);

export function mcpUserEntries(definitions={}) {
  if(!isConfigObject(definitions))return null;
  return Object.entries(definitions).map(([name,definition])=>({
    name,transport:definition?.type==='http' || definition?.url ? 'http' : 'stdio',
  }));
}
