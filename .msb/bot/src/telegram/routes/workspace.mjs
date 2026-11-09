/**
 * MCP callback -> captured provider catalog -> [workspace views](../screens/workspace.mjs).
 * [Readers](../../mcp/catalog.mjs), [owner/render scope](../router.mjs),
 * [production ingress checks](../../../tests/mcp-catalog.test.mjs).
 */
import {mcpCatalog,selectedMcpProvider} from '../../mcp/catalog.mjs';
import {loadState} from '../../state.mjs';
import {resolveMcpReference} from '../../mcp/reference.mjs';
import {mcpAddScreen,mcpCardScreen,mcpReadErrorScreen,mcpMissingScreen,mcpScreen,
  mcpWorkspaceScreen,openClawMcpScreen} from '../screens/workspace.mjs';
import {placeholder} from '../screens/shared.mjs';
import {UNHANDLED} from './shared.mjs';

const TOP='menu:mcp';
const FOLDER='mcp:folder:workspace';
const CARD='mcp:server:';
export const isMcpReadCallback=data=>data===TOP || data===FOLDER || data.startsWith(CARD);

export async function handleWorkspaceRoute({data,state,bot,show,signal}) {
  if(data==='mcp:add')return show(mcpAddScreen());
  if(!isMcpReadCallback(data))return data.startsWith('mcp:') ? show(placeholder('MCP',TOP)) : UNHANDLED;
  if(state.engine==='oc' && data!==TOP)return show(mcpMissingScreen(TOP));

  const catalog=await mcpCatalog(state,{readProvider:bot[Symbol.for('msb.mcpProvider')],withStatus:data===FOLDER,signal});
  if(signal?.aborted)return;
  // A switch in another owner chat does not abort this chat's render scope.
  const {state:current}=await loadState();
  if(selectedMcpProvider(current)!==selectedMcpProvider(state))return;
  if(!catalog)return show(mcpReadErrorScreen(data===TOP?'menu:back':TOP));
  if(catalog.provider==='oc')return show(openClawMcpScreen(catalog.entries));
  if(data===TOP)return show(mcpScreen(catalog.entries.length));
  if(data===FOLDER)return show(mcpWorkspaceScreen(catalog));
  const row=resolveMcpReference(data.slice(CARD.length),catalog);
  return show(row?mcpCardScreen(row):mcpMissingScreen(FOLDER));
}
