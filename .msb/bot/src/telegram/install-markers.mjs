/**
 * Final Telegram turn -> installation results in the old skill/MCP order.
 * [Worker](bot.mjs) owns abort/delivery; [skills](../skills/response-markers.mjs)
 * and [MCP](../mcp/response-markers.mjs) write only the captured targets.
 */
import {processSkillMarkers} from '../skills/response-markers.mjs';
import {processMcpMarkers} from '../mcp/response-markers.mjs';

export async function processInstallMarkers(out,{signal,readProvider}={}) {
  const text=out.skillInstall?.providerId==='oc' && !out.ok
    ? out.text : await processSkillMarkers(out.text,out.skillInstall,{signal});
  return processMcpMarkers(text,out.mcpInstall,{signal,readProvider});
}
