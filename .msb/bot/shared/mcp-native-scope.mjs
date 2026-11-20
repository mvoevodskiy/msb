/**
 * Native configuration paths and scoped per-bot removal metadata. Shared by the
 * [Claude reader](../src/mcp/claude.mjs), [Codex reader](../../../overlay/bot/ext/codex-mcp.mjs)
 * and [turn preparation](../src/mcp/launch.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isConfigObject} from './mcp-user-entries.mjs';

export function claudeMcpPath(cwd,env) {
  return path.resolve(cwd,env.CLAUDE_CONFIG_DIR || env.HOME || os.homedir(),'.claude.json');
}

export function codexMcpPath(cwd,env) {
  return path.resolve(cwd,env.CODEX_HOME || path.join(env.HOME || os.homedir(),'.codex'),'config.toml');
}

export async function canonicalMcpPath(file) {
  try{return await fs.realpath(file);}
  catch{
    // Keep an absent file bound to its real parent when the CLI canonicalizes its home.
    try{return path.join(await fs.realpath(path.dirname(file)),path.basename(file));}
    catch{return file;}
  }
}

export function nativeMcpScope(provider,cwd,env) {
  const file=provider==='claude'?claudeMcpPath(cwd,env):codexMcpPath(cwd,env);
  return canonicalMcpPath(file);
}

export function removedNativeNames(state,provider,scope) {
  const profiles=state.removedNativeMcp?.[provider];
  const names=scope && isConfigObject(profiles) && Object.hasOwn(profiles,scope)?profiles[scope]:null;
  return Array.isArray(names)?names.filter(name=>typeof name==='string' && name):[];
}

export async function codexNativeRemoval(state,cwd,env) {
  if(!state.removedNativeMcp?.codex)return;
  const scope=await nativeMcpScope('codex',cwd,env);
  return {scope,names:removedNativeNames(state,'codex',scope)};
}
