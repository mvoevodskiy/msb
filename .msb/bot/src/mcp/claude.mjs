/**
 * Claude user MCP definitions and optional status of this bot. Read-only, no probe.
 * [Dispatch](./catalog.mjs), [reference](../../tests/reference/parity-mcp-contract.txt),
 * [ingress checks](../../tests/mcp-catalog.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {homeDir,sessionDir} from '../paths.mjs';
import {isConfigObject,mcpUserEntries} from '../../shared/mcp-user-entries.mjs';

async function readStatus(env,signal) {
  try {
    const file=path.join(path.dirname(sessionDir(env)),'mcp-status.json');
    const status=JSON.parse(await fs.readFile(file,{encoding:'utf8',signal}));
    const byName=new Map();
    for(const row of Object.values(status?.servers ?? {})) {
      if(typeof row?.name==='string' && typeof row.status==='string')byName.set(row.name,row.status.toLowerCase());
    }
    const timestamp=status?.at;
    const at=typeof timestamp==='string' || typeof timestamp==='number' ? new Date(timestamp) : null;
    return {byName,at:at && Number.isFinite(at.getTime())?at.toISOString().slice(11,16):null};
  }catch{return {};}
}

export async function readClaudeMcp({env=process.env,signal,withStatus=false}={}) {
  const root=path.resolve(env.CLAUDE_CONFIG_DIR || homeDir(env),'.claude.json');
  let definitions;
  try {
    const config=JSON.parse(await fs.readFile(root,{encoding:'utf8',signal}));
    if(!isConfigObject(config))return null;
    definitions=config.mcpServers ?? undefined;
  }catch(error){if(error.code!=='ENOENT')return null;}
  const entries=mcpUserEntries(definitions);
  if(!entries)return null;
  if(!withStatus || !entries.length)return {root,entries};
  const {byName,at}=await readStatus(env,signal);
  return {root,at,entries:entries.map(entry=>({...entry,status:byName?.get(entry.name)}))};
}

export function claudeMcpPermission(name) {
  // Do not turn an unsupported raw config name into a CLI pattern or separator.
  if(!name || /[^a-z0-9_-]/i.test(name))return null;
  const rule='mcp__'+name;
  return name.includes('__') || name.endsWith('_') ? rule+'__*' : rule;
}
