/**
 * Old MCP templates and their native credential references. No token values.
 * [Telegram form](../src/telegram/forms/mcp.mjs), [turn preparation](../src/mcp/launch.mjs),
 * [Codex projection](../../../overlay/bot/ext/codex-mcp-launch.mjs).
 */
const templates={
  supadata:{
    name:'supadata',key:'SUPADATA_API_KEY',prefix:'sd_',url:'https://api.supadata.ai/mcp',
    childKey:'MSB_MCP_SUPADATA_TOKEN',header:'x-api-key',bearer:false,
  },
  apify:{
    name:'apify',key:'APIFY_API_KEY',prefix:'apify_api_',url:'https://mcp.apify.com',
    childKey:'MSB_MCP_APIFY_TOKEN',header:'Authorization',bearer:true,
  },
};

export function mcpTemplate(name) {
  return Object.hasOwn(templates,name)?templates[name]:undefined;
}
