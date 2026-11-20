/**
 * Old ADD_MCP model instruction and payload grammar.
 * [Producer](../agent/turn.mjs), [response processor](response-markers.mjs),
 * [old contract](../../tests/reference/parity-mcp-contract.txt).
 */
import {isConfigObject} from '../../shared/mcp-user-entries.mjs';

export const MCP_OPEN='[ADD_MCP]';
const MCP_CLOSE='[/ADD_MCP]';
export const INVALID_MCP='Не понял настройки сервера — нужен адрес https и имя латиницей.';
export const MCP_WRITE_FAILED='Не получилось подключить сервер — попробуй ещё раз.';
export const isCustomMcpName=name=>typeof name==='string' && /^[a-z0-9][a-z0-9_-]{1,48}$/.test(name);

export function mcpInstallPrompt(target) {
  if(!target)return '';
  return `## MCP
Подключать сервер ты можешь ТОЛЬКО маркером: файлы настроек не трогай.
MCP: [ADD_MCP]{"name":"имя","type":"http","url":"https://...","headers":{"ключ":"значение"}}[/ADD_MCP]
Для stdio: [ADD_MCP]{"name":"имя","type":"stdio","command":"...","args":["..."]}[/ADD_MCP]
Бот исполнит маркер и подставит результат вместо него. Успех словами НЕ обещай до результата.`;
}

function markerClose(text,from) {
  let quoted=false;
  for(let i=from;i<text.length;i++){
    if(text[i]==='"')quoted=!quoted;
    else if(quoted && text[i]==='\\')i++;
    else if(!quoted && text.startsWith(MCP_CLOSE,i))return i;
  }
  return -1;
}

export function mcpMarkerRanges(text) {
  const ranges=[];
  let start=text.indexOf(MCP_OPEN);
  while(start!==-1){
    const from=start+MCP_OPEN.length,close=markerClose(text,from);
    if(close===-1){
      // Preserve a plain mention of the marker. A truncated JSON payload can contain keys.
      const payload=text.slice(from).trimStart();
      if(payload.startsWith('{') || payload.startsWith('['))ranges.push({start,end:text.length});
      break;
    }
    const end=close+MCP_CLOSE.length;
    ranges.push({start,end,from,close});
    start=text.indexOf(MCP_OPEN,end);
  }
  return ranges;
}

const trimmed=value=>typeof value==='string'?value.trim():'';
export function parseMcpPayload(text) {
  let value;
  try{value=JSON.parse(text);}catch{return null;}
  if(!isConfigObject(value))return null;
  const name=trimmed(value.name).toLowerCase(),type=trimmed(value.type);
  if(!isCustomMcpName(name))return null;

  if(type==='http'){
    const url=trimmed(value.url);
    if(!/^https:\/\/\S+$/.test(url))return null;
    const headers=isConfigObject(value.headers)
      ? Object.fromEntries(Object.entries(value.headers).filter(([,header])=>typeof header==='string')) : {};
    return {name,config:{type,url,...(Object.keys(headers).length?{headers}:{})}};
  }

  if(type==='stdio'){
    const command=trimmed(value.command);
    if(!command)return null;
    const args=Array.isArray(value.args)?value.args.filter(argument=>typeof argument==='string'):undefined;
    return {name,config:{type,command,...(args?{args}:{})}};
  }
  return null;
}
