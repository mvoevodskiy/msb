/**
 * Selected engine snapshot -> one MCP catalog. No cross-provider fallback.
 * [Telegram route](../telegram/routes/workspace.mjs), [Claude](./claude.mjs),
 * [OpenClaw](./openclaw.mjs), [Codex bridge](../../../../overlay/bot/ext/codex-mcp.mjs),
 * [ingress checks](../../tests/mcp-catalog.test.mjs).
 */
import {selectedSessionProvider} from '../../shared/session-starts.mjs';
import {projectLocations} from '../projects/paths.mjs';
import {readClaudeMcp} from './claude.mjs';
import {readOpenClawMcp} from './openclaw.mjs';

export function selectedMcpProvider(state) {
  return state.engine==='oc'?'oc':selectedSessionProvider(state);
}

export async function mcpCatalog(state,{env=process.env,readProvider,signal,withStatus=false}={}) {
  const provider=selectedMcpProvider(state);
  try {
    const options={env,signal};
    if(provider==='oc') {
      const entries=await readOpenClawMcp(options);
      return entries?{provider,entries}:null;
    }
    const cwd=projectLocations(env).workspace;
    const result=provider==='claude' ? await readClaudeMcp({...options,cwd,withStatus})
      : provider==='codex' ? await readProvider?.(state,{...options,cwd})
      : null;
    return result && Array.isArray(result.entries) ? {...result,provider} : null;
  }catch{return null;}
}
