/**
 * Private, immutable ADD_MCP definitions. The [registry](managed.mjs) keeps
 * only a reference in state; it publishes/retires the reference after IO.
 * [Launch](launch.mjs) reads definitions for the captured bot and provider.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {botRoot} from '../paths.mjs';
import {parseMcpPayload} from './install-protocol.mjs';

const directory=env=>path.join(botRoot(env),'mcp-config');
const filePath=(record,env)=>path.join(directory(env),record.custom+'.json');

export function isCustomMcpRecord(record) {
  return typeof record?.custom==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.custom)
    && (record.transport==='http' || record.transport==='stdio');
}

export async function createCustomMcpConfig(config,env) {
  const record={custom:randomUUID(),transport:config.type};
  await fs.mkdir(directory(env),{recursive:true,mode:0o700});
  const file=filePath(record,env);
  try{
    await fs.writeFile(file,JSON.stringify(config)+'\n',{flag:'wx',mode:0o600});
    return record;
  }catch(error){
    if(error.code!=='EEXIST')await fs.unlink(file).catch(()=>{});
    throw error;
  }
}

export async function readCustomMcpConfig(name,record,env) {
  try{
    const config=JSON.parse(await fs.readFile(filePath(record,env),'utf8'));
    const parsed=parseMcpPayload(JSON.stringify({...config,name}));
    if(!parsed || parsed.config.type!==record.transport)throw Error('Invalid MCP configuration');
    return parsed;
  }catch(error){
    // A replacement or removal can retire a reference from a captured turn.
    if(error.code==='ENOENT')return null;
    throw Error('Не удалось прочитать MCP выбранного бота.');
  }
}

export async function retireCustomMcpConfig(record,env) {
  if(isCustomMcpRecord(record))await fs.unlink(filePath(record,env)).catch(()=>{});
}
