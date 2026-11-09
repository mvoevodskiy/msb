/** Real Telegram and overlay ingress with owned MCP config and fake native executables. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './menu-fixture.mjs';
import {loadState,saveState} from '../../src/state.mjs';
import {sessionDir} from '../../src/paths.mjs';

export async function mcpFixture(t, provider='claude', {mode='ok', clawServers}={}) {
  const f=await fixture(t,undefined,{overlay:provider==='codex'});
  const state=(await loadState()).state;
  await saveState({...state,engine:provider==='oc'?'oc':'cc',extAuthBypass:provider==='codex'?'codex':undefined});
  const bin=path.join(f.home,'.local/bin');
  const log=path.join(f.home,'mcp-protocol.jsonl');
  const released=path.join(f.home,'release-mcp-read');
  await fs.mkdir(bin,{recursive:true});
  const config=path.join(f.home,'configured-claude/.claude.json');
  process.env.CLAUDE_CONFIG_DIR=path.dirname(config);
  process.env.CODEX_HOME=path.join(f.home,'configured-codex');
  process.env.PATH=bin+path.delimiter+process.env.PATH;
  await fs.mkdir(path.dirname(config),{recursive:true});
  await fs.mkdir(process.env.CODEX_HOME,{recursive:true});
  const native=path.join(process.env.CODEX_HOME,'config.toml');
  await fs.writeFile(native,'# native config owned by this fixture\n');
  const rows={zulu:{command:'fixture-command',args:['fixture-private-args'],env:{TOKEN:'fixture-private-env'}},
    'alpha<&':{url:'https://fixture.invalid/mcp',headers:{Authorization:'fixture-private-header'}}};
  await fs.writeFile(config,JSON.stringify({mcpServers:rows,other:'keep'}));
  const sidecar=path.join(path.dirname(sessionDir()),'mcp-status.json');
  await fs.mkdir(path.dirname(sidecar),{recursive:true});
  await fs.writeFile(sidecar,JSON.stringify({at:'2026-10-01T06:07:00Z',servers:{z:{name:'zulu',status:'failed'},a:{name:'alpha<&',status:'needs-auth'}}}));
  const rpcData={mode,log,released,native,rows:{'native-only':{url:'https://fixture.invalid/mcp?private=fixture-private-query',http_headers:{Authorization:'fixture-private-header'},env:{TOKEN:'fixture-private-env'}}}};
  const codexScript=`import fs from 'node:fs';import{createInterface}from'node:readline';
const data=${JSON.stringify(rpcData)};
if(process.argv.slice(2).join(' ')!=='app-server')process.exit(7);
let initialized=false;
createInterface({input:process.stdin}).on('line',async line=>{
  const q=JSON.parse(line);fs.appendFileSync(data.log,JSON.stringify(q)+'\\n');
  if(q.method==='initialize'){console.log(JSON.stringify({id:q.id,result:{}}));return;}
  if(q.method==='initialized'){initialized=true;return;}
  if(!initialized||q.method!=='config/read')process.exit(8);
  if(data.mode==='hold')while(!fs.existsSync(data.released))await new Promise(r=>setTimeout(r,5));
  if(data.mode==='error'){console.log(JSON.stringify({id:q.id,error:{code:-32603,message:'fixture-private-server-error'}}));return;}
  const config={mcp_servers:data.rows};
  console.log(JSON.stringify({id:q.id,result:{config:{mcp_servers:{...data.rows,'repo-only':{command:'false'}}},layers:[{name:{type:'user',file:data.mode==='wrong-root'?data.native+'.foreign':data.native},config}]}}));
});`;
  const ocData={log,servers:clawServers??{mcp:{servers:{zulu:{command:'node',args:['fixture-private-args']},alpha:{url:'https://user:pass@fixture.invalid/mcp?key=fixture-private-query#private',transport:'sse'}}}}};
  const ocScript=`import fs from 'node:fs';const data=${JSON.stringify(ocData)};const argv=process.argv.slice(2);
fs.appendFileSync(data.log,JSON.stringify({argv})+'\\n');if(argv.join(' ')!=='mcp list --json')process.exit(7);
console.log(JSON.stringify(data.servers));`;
  await fs.writeFile(path.join(bin,'codex'),'#!'+process.execPath+'\n'+codexScript,{mode:0o700});
  await fs.writeFile(path.join(bin,'openclaw'),'#!'+process.execPath+'\n'+ocScript,{mode:0o700});
  async function calls(){try{return(await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}
    catch(e){if(e.code==='ENOENT')return[];throw e;}}
  async function callback(data,uid=42,{wait=true,...renderOptions}={}) {
    const tasks=Symbol.for('msb.callbackTasks'),old=new Set(f.bot[tasks]||[]);
    await f.callback(data,uid,{...renderOptions,waitForRender:false});
    if(wait)await Promise.allSettled([...(f.bot[tasks]||[])].filter(task=>!old.has(task)));
  }
  return {...f,config,native,sidecar,calls,callback,release:()=>fs.writeFile(released,'released')};
}
