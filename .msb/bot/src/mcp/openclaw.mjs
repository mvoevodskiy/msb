/**
 * Old OpenClaw MCP JSON envelopes, one retry and safe list metadata.
 * [Owned subprocess](../agent/openclaw-read.mjs), [dispatch](./catalog.mjs),
 * [reference](../../tests/reference/parity-mcp-contract.txt), [ingress](../../tests/mcp-catalog.test.mjs).
 */
import {setTimeout as delay} from 'node:timers/promises';
import {isConfigObject} from '../../shared/mcp-user-entries.mjs';
import {readOpenClawOutput} from '../agent/openclaw-read.mjs';

function endpoint(value) {
  try {
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol))return '';
    url.username='';url.password='';url.search='';url.hash='';
    return url.pathname==='/' && !value.split(/[?#]/,1)[0].endsWith('/') ? url.origin : url.href;
  }catch{return '';}
}

function parseOpenClawMcp(text) {
  let data;
  try{data=JSON.parse(text);}catch{return null;}
  const table=data?.mcp?.servers ?? data?.servers ?? data;
  const rows=Array.isArray(table) ? table
    : isConfigObject(table) ? Object.entries(table).map(([name,row])=>({...row,name})) : null;
  if(!rows)return null;
  return rows.filter(isConfigObject).flatMap(row=>{
    const name=String(row.name ?? '').trim();
    if(!name)return [];
    const url=String(row.url ?? '').trim();
    const command=String(row.command ?? row.cmd ?? '').trim();
    const transport=String(row.type ?? row.transport ?? '').trim().toLowerCase() || (url?'http':command?'stdio':'');
    return [{name,transport:transport==='sse'?'http':transport || '—',target:url?endpoint(url):command}];
  });
}

let cold=true;
export async function readOpenClawMcp({env=process.env,signal,read=readOpenClawOutput,
  timeoutMs=15_000,coldTimeoutMs=45_000,retryMs=2_000}={}) {
  if(signal?.aborted)return null;
  const firstTimeout=cold?coldTimeoutMs:timeoutMs;
  cold=false;
  const attempt=async timeout=>parseOpenClawMcp(await read(['mcp','list','--json'],{env,signal,timeoutMs:timeout}));
  const first=await attempt(firstTimeout);
  if(first || signal?.aborted)return first;
  try{await delay(retryMs,undefined,{signal});}catch{return null;}
  return attempt(timeoutMs);
}
