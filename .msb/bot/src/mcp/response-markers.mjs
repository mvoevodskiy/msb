/**
 * Completed model text -> the old ADD_MCP result before plan and history.
 * [Protocol](install-protocol.mjs), [bot registry](managed.mjs),
 * [delivery](../telegram/install-markers.mjs), [ingress](../../tests/mcp-marker.test.mjs).
 */
import {MCP_OPEN,INVALID_MCP,MCP_WRITE_FAILED,mcpMarkerRanges,parseMcpPayload} from './install-protocol.mjs';
import {codexManagedMcpName} from '../../shared/codex-mcp-name.mjs';
import {enrollCustomMcp} from './managed.mjs';
import {readClaudeMcp} from './claude.mjs';
import {nativeMcpScope} from '../../shared/mcp-native-scope.mjs';

async function inheritedScope(name,target,{env,signal,readProvider}) {
  const options={cwd:target?.cwd,env,signal};
  if(!target?.nativeScope || await nativeMcpScope(target.provider,target.cwd,env)!==target.nativeScope)
    throw Error('MCP profile changed during the turn');
  if(target.provider==='claude'){
    const view=await readClaudeMcp(options);
    if(view?.scope!==target.nativeScope)throw Error('Unreadable or changed Claude MCP profile');
    return view.entries.some(row=>row.name===name)?view.scope:undefined;
  }
  if(target.provider==='codex'){
    const view=await readProvider?.({engine:'cc',extAuthBypass:'codex'},{...options,effective:true});
    const alias=codexManagedMcpName(name,target.env);
    if(view?.scope!==target.nativeScope || view.entries.some(row=>row.name===alias))throw Error('Unavailable MCP alias');
    return view.nativeNames.includes(name)?view.scope:undefined;
  }
}

export async function processMcpMarkers(text,target,{env=process.env,signal,readProvider}={}) {
  if(typeof text!=='string' || !text.includes(MCP_OPEN))return text;
  signal?.throwIfAborted();
  const ranges=mcpMarkerRanges(text),first=ranges[0];
  if(!first)return text.trim();
  const enabled=env.SKILL_INSTALL_ENABLED!=='0';
  const server=enabled && first.close!==undefined?parseMcpPayload(text.slice(first.from,first.close)):null;
  let message=enabled?INVALID_MCP:'';
  if(server){
    try{
      const replaceScope=await inheritedScope(server.name,target,{env,signal,readProvider});
      await enrollCustomMcp(server,target,{signal,replaceScope,nativeEnv:env});
      signal?.throwIfAborted();
      message='Подключил MCP-сервер «'+server.name+'». Заработает со следующего сообщения.';
    }catch(error){
      if(signal?.aborted)throw error;
      message=MCP_WRITE_FAILED;
    }
  }
  let end=0;
  const parts=[];
  for(const range of ranges){
    parts.push(text.slice(end,range.start),message);
    message='';
    end=range.end;
  }
  return (parts.join('')+text.slice(end)).trim();
}
