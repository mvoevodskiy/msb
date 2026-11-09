/**
 * MCP callbacks -> current provider catalog, token form and scoped deletion.
 * [Readers](../../mcp/catalog.mjs), [enrollment](../../mcp/managed.mjs),
 * [views](../screens/workspace.mjs), [catalog](../../../tests/mcp-catalog.test.mjs) /
 * [form and removal checks](../../../tests/mcp-setup.test.mjs).
 */
import {mcpTemplate} from '../../../shared/mcp-templates.mjs';
import {mcpCatalog,selectedMcpProvider} from '../../mcp/catalog.mjs';
import {includeManagedMcp,managedMcpRows,removeManagedMcpTemplate,supportsManagedMcp} from '../../mcp/managed.mjs';
import {loadState} from '../../state.mjs';
import {statePath} from '../../paths.mjs';
import {resolveMcpReference,mcpReference} from '../../mcp/reference.mjs';
import {mcpAddScreen,mcpTemplatePrompt} from '../screens/mcp-setup.mjs';
import {mcpCardScreen,mcpReadErrorScreen,mcpMissingScreen,mcpScreen,mcpWorkspaceScreen,openClawMcpScreen} from '../screens/workspace.mjs';
import {placeholder} from '../screens/shared.mjs';
import {UNHANDLED} from './shared.mjs';

const TOP='menu:mcp';
const ADD='mcp:add';
const FOLDER='mcp:folder:workspace';
const CARD='mcp:server:';
const SETUP='mcp:setup:';
const DELETE='mcp:delete:';
export const isMcpReadCallback=data=>data===TOP || data===ADD || data===FOLDER || data.startsWith(CARD);

export async function handleWorkspaceRoute({data,state,bot,show,signal,pending,chatId}) {
  if(data!==TOP && !data.startsWith('mcp:'))return UNHANDLED;
  const provider=selectedMcpProvider(state);
  const readProvider=bot[Symbol.for('msb.mcpProvider')];
  if(data.startsWith(SETUP)){
    const name=data.slice(SETUP.length);
    if(!mcpTemplate(name) || !supportsManagedMcp(provider)){
      return show(placeholder('MCP',ADD,'Настройка MCP недоступна для выбранного движка.'));
    }
    pending.set(chatId,'mcp-setup');
    pending.advance(chatId,'mcp-setup',{name,provider,root:statePath(),readProvider});
    return show(mcpTemplatePrompt(name));
  }

  const deleting=data.startsWith(DELETE);
  if(deleting){
    const entries=managedMcpRows(state,provider);
    const row=resolveMcpReference(data.slice(DELETE.length),{provider,entries});
    if(!row)return show(mcpMissingScreen(FOLDER));
    try {
      const latest=await removeManagedMcpTemplate({provider,name:row.name});
      if(selectedMcpProvider(latest)!==provider)return;
    }catch{return show(placeholder('MCP',FOLDER,'Не удалось удалить MCP-сервер.'));}
  }else if(!isMcpReadCallback(data))return show(placeholder('MCP',TOP));

  if(provider==='oc' && data!==TOP && data!==ADD)return show(mcpMissingScreen(TOP));
  if(signal?.aborted)return;
  const native=await mcpCatalog(state,{readProvider,withStatus:data===FOLDER || deleting,signal});
  if(signal?.aborted)return;
  // A switch in another owner chat does not abort this chat's render scope.
  const {state:current}=await loadState();
  if(selectedMcpProvider(current)!==provider)return;
  if(!native)return show(mcpReadErrorScreen(data===TOP?'menu:back':TOP));
  const catalog=includeManagedMcp(native,current);
  if(data===ADD)return show(mcpAddScreen(catalog));
  if(provider==='oc')return show(openClawMcpScreen(catalog.entries));
  if(data===TOP)return show(mcpScreen(catalog.entries.length));
  if(data===FOLDER || deleting)return show(mcpWorkspaceScreen(catalog));
  const row=resolveMcpReference(data.slice(CARD.length),catalog);
  if(!row)return show(mcpMissingScreen(FOLDER));
  return show(mcpCardScreen(row,row.managed?DELETE+mcpReference(catalog,row):undefined));
}
