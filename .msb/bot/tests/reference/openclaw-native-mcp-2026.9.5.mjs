/** End-to-end OpenClaw 2026.9.5/acpx 0.13.0 in a Docker loopback-only fixture. */
import {runAgentTurn} from '../../src/agent/turn.mjs';
import {ownedOpenClawProfile} from '../../src/agent/openclaw-profile.mjs';
import {setupOpenClawTemplate} from '../../src/mcp/openclaw-setup.mjs';
import {mcpTemplate} from '../../shared/mcp-templates.mjs';
import {loadState,saveState} from '../../src/state.mjs';
import {readEnvMap} from '../../src/env/store.mjs';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const cli=process.argv[2], acpx=process.argv[3];
const root='/tmp/msb-oc-lab',bin=path.join(root,'bin');
const key='sd_fixture_loopback_mcp',seen=[];
let connected=false,alternateCalls=0;
let turns=0,toolResults=0,requestsBeforeTurn=0;
const responseServer=http.createServer(async(req,res)=>{
  try{
    if(req.method!=='POST'){res.writeHead(404).end();return;}
    let body='';for await(const chunk of req)body+=chunk;
    const data=JSON.parse(body);
    if(req.url==='/v1/chat/completions' || req.url==='/alternate/v1/chat/completions'){
      const alternate=req.url.startsWith('/alternate/');
      if(alternate)alternateCalls++;
      turns++;
      const result=connected && data.messages?.some(row=>row.role==='tool' && JSON.stringify(row.content).includes('oc-fixture-tool-output'));
      if(result)toolResults++;
      const tool=data.tools?.find(row=>row.function?.name?.includes('probe'));
      if(connected && !result && !tool){
        res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'fixture did not receive MCP tool',type:'invalid_request_error'}}));return;
      }
      res.writeHead(200,{'content-type':'text/event-stream'});
      const emit=(delta,finish)=>res.write('data: '+JSON.stringify({
        id:'chatcmpl_fixture_'+turns,object:'chat.completion.chunk',created:1,model:'msb-oc-fixture',
        choices:[{index:0,delta,finish_reason:finish}],
      })+'\n\n');
      emit({role:'assistant'},null);
      if(!connected || result)emit({content:alternate?'OpenClaw fixture alternate Gateway':connected?'OpenClaw fixture complete':'OpenClaw fixture seed'},null);
      else emit({tool_calls:[{index:0,id:'call_oc_fixture',type:'function',function:{name:tool.function.name,arguments:'{}'}}]},null);
      emit({},!connected || result?'stop':'tool_calls');
      res.end('data: [DONE]\n\n');return;
    }
    if(req.url!=='/mcp' || req.headers['x-api-key']!==key){res.writeHead(401).end();return;}
    seen.push(data.method);
    if(data.id===undefined){res.writeHead(202).end();return;}
    const result={
      initialize:{protocolVersion:data.params?.protocolVersion,serverInfo:{name:'owned-fixture',version:'1'},capabilities:{tools:{}}},
      'tools/list':{tools:[{name:'probe',description:'Owned fixture',inputSchema:{type:'object',properties:{}}}]},
      'tools/call':{content:[{type:'text',text:'oc-fixture-tool-output'}],isError:false},
    }[data.method];
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:data.id,result}));
  }catch{res.writeHead(500).end();}
});
function child(args,env,command=process.execPath,timeout=25000){
  return new Promise(resolve=>{
    const p=execFile(command,args,{cwd:env.HOME,env,timeout,maxBuffer:4*1024*1024},(error,stdout,stderr)=>{
      resolve({ok:!error,code:error?.code ?? 0,stdout,stderr});
    });
    p.stdin?.on('error',()=>{});p.stdin?.end();
  });
}
const run=(env,...args)=>child([cli,...args],env);
const requireOk=(result,label)=>{
  if(!result.ok)throw Error(label+' code='+result.code+'\n'+result.stderr.slice(-1800)+'\n'+result.stdout.slice(-1200));
  return result.stdout;
};
async function freePort(){
  const s=net.createServer();
  await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
  const port=s.address().port;
  await new Promise(resolve=>s.close(resolve));
  return port;
}
async function profile(id,port,modelPort){
  const home=path.join(root,id),botData=path.join(root,'msb'),state=path.join(botData,'bots',id,'openclaw');
  const workspace=path.join(home,'workspace'),config=path.join(state,'openclaw.json');
  await Promise.all([state,workspace].map(p=>fs.mkdir(p,{recursive:true,mode:0o700})));
  const env={HOME:home,MSB_RUNTIME_PROFILE:'msb',MSB_RUNTIME_ROOT:botData,MSB_BOT_ID:id,MSB_WORKSPACE_DIR:workspace,PATH:bin+':/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:root,CI:'1',
    OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:config,OPENCLAW_OFFLINE:'1',OPENCLAW_NO_AUTO_UPDATE:'1',
    OPENCLAW_HIDE_BANNER:'1',OPENCLAW_SUPPRESS_NOTES:'1'};
  const json={
    gateway:{mode:'local',bind:'loopback',port,auth:{mode:'token',token:'fixture-gateway-'+id},controlUi:{enabled:false}},
    discovery:{mdns:{mode:'off'}},
    agents:{defaults:{workspace,model:{primary:'fixture/msb-oc-fixture'}}},
    models:{mode:'merge',providers:{fixture:{baseUrl:'http://127.0.0.1:'+modelPort+'/v1',apiKey:'fixture-model-key',api:'openai-completions',
      models:[{id:'msb-oc-fixture',name:'Synthetic model',reasoning:false,input:['text'],contextWindow:131072,maxTokens:4096}]}}},
  };
  await fs.writeFile(config,JSON.stringify(json,null,2)+'\n',{mode:0o600});
  return {env,state,workspace,config,port};
}
function startGateway(p){
  const proc=spawn(process.execPath,[cli,'gateway','run','--port',String(p.port)],{env:p.env,cwd:p.workspace,stdio:['ignore','pipe','pipe']});
  let log='';for(const stream of [proc.stdout,proc.stderr])stream.on('data',chunk=>{log=(log+chunk).slice(-8000);});
  return {proc,log:()=>log,exited:new Promise(resolve=>proc.once('close',resolve))};
}
async function waitGateway(p,g){
  const until=Date.now()+25000;
  while(Date.now()<until){
    if(g.proc.exitCode!==null)break;
    try{const reply=await fetch('http://127.0.0.1:'+p.port+'/health',{signal:AbortSignal.timeout(500)});if(reply.ok)return;}catch{}
    await delay(100);
  }
  throw Error('Gateway was not ready: '+g.log());
}
let gateway,alternateGateway;
try{
  await fs.mkdir(bin,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(bin,'openclaw'),'#!/bin/sh\nexec '+process.execPath+' '+cli+' "$@"\n',{mode:0o700});
  await fs.writeFile(path.join(bin,'acpx'),'#!/bin/sh\nexec '+acpx+' "$@"\n',{mode:0o700});
  await new Promise(resolve=>responseServer.listen(0,'127.0.0.1',resolve));
  const modelPort=responseServer.address().port;
  const a=await profile('a',await freePort(),modelPort),b=await profile('b',await freePort(),modelPort);
  const bBefore=await fs.readFile(b.config,'utf8');
  const aBefore=JSON.parse(await fs.readFile(a.config,'utf8'));
  const version=requireOk(await run(a.env,'--version'),'version').trim();
  assert.match(version,/2026\.9\.5/);
  const acpxVersion=requireOk(await child(['--version'],a.env,acpx),'acpx version').trim();
  assert.equal(acpxVersion,'0.13.0');
  await saveState({engine:'oc',ccSessionId:'fixture-other-engine'},a.env);
  gateway=startGateway(a);await waitGateway(a,gateway);
  const nativeMode=JSON.parse(requireOk(await run(a.env,'config','get','gateway.mode','--json'),'gateway mode'));
  assert.equal(nativeMode,'local');
  const snapshot=JSON.parse(requireOk(await run(a.env,'gateway','call','config.get','--json'),'gateway identity'));
  assert.equal(await fs.realpath(snapshot.path),await fs.realpath(a.config));
  const seed=await runAgentTurn({prompt:'Seed the owned conversation.',env:a.env});
  assert.equal(seed.ok,true,seed.text);
  assert.match(seed.text,/OpenClaw fixture seed/);
  const previous=(await loadState(a.env)).state;
  assert.ok(previous.ocSessionId && previous.ocSessionName);
  const target=await ownedOpenClawProfile(a.env);
  assert.ok(target);
  const localUrl='http://127.0.0.1:'+modelPort+'/mcp';
  const registered=await setupOpenClawTemplate({template:{...mcpTemplate('supadata'),url:localUrl},value:key,profile:target,env:a.env});
  assert.equal(registered.ok,true,'The real writer must verify the same Gateway config');
  requestsBeforeTurn=seen.length;
  assert.equal(requestsBeforeTurn,0,'Saving a registration must not probe its endpoint');
  assert.equal((await readEnvMap(a.env)).map.get('SUPADATA_API_KEY'),key);
  assert.equal((await readEnvMap(b.env)).map.has('SUPADATA_API_KEY'),false);
  const changed=JSON.parse(await fs.readFile(a.config,'utf8'));
  assert.equal(changed.mcp.servers.supadata.headers['x-api-key'],key);
  assert.deepEqual(changed.gateway,aBefore.gateway);
  assert.deepEqual(changed.agents,aBefore.agents);
  const shown=JSON.parse(requireOk(await run(a.env,'mcp','list','--json'),'native list'));
  assert.equal(shown.supadata.url,localUrl);
  connected=true;
  const out=await runAgentTurn({prompt:'Use the configured Supadata probe tool once.',env:a.env});
  assert.equal(out.ok,true,out.text);
  assert.match(out.text,/OpenClaw fixture complete/);
  assert.ok(toolResults>0 && seen.includes('tools/call'));
  const next=(await loadState(a.env)).state;
  assert.equal(next.ocSessionId,previous.ocSessionId);
  assert.equal(next.ocSessionName,previous.ocSessionName);
  assert.equal(next.ccSessionId,'fixture-other-engine');
  assert.equal(await fs.readFile(b.config,'utf8'),bBefore);
  assert.equal(gateway.proc.exitCode,null);

  // A second native profile under the same bot and cwd must not reuse A's warm acpx queue owner.
  const alternatePort=await freePort(),alternateState=path.join(path.dirname(a.state),'openclaw alternate');
  const alternateConfig=path.join(alternateState,'openclaw.json');
  await fs.mkdir(alternateState,{mode:0o700});
  const alternateSource=structuredClone(aBefore);
  alternateSource.gateway.port=alternatePort;
  alternateSource.models.providers.fixture.baseUrl='http://127.0.0.1:'+modelPort+'/alternate/v1';
  await fs.writeFile(alternateConfig,JSON.stringify(alternateSource,null,2)+'\n',{mode:0o600});
  const alternate={...a,port:alternatePort,config:alternateConfig,state:alternateState,
    env:{...a.env,OPENCLAW_STATE_DIR:alternateState,OPENCLAW_CONFIG_PATH:alternateConfig}};
  alternateGateway=startGateway(alternate);
  await waitGateway(alternate,alternateGateway);
  const toolCount=seen.filter(method=>method==='tools/call').length;
  connected=false;
  const switched=await runAgentTurn({prompt:'Use the alternate owned Gateway.',env:alternate.env});
  assert.equal(switched.ok,true,switched.text);
  assert.match(switched.text,/OpenClaw fixture alternate Gateway/);
  assert.ok(alternateCalls>0);
  assert.equal(seen.filter(method=>method==='tools/call').length,toolCount);
  const afterSwitch=(await loadState(a.env)).state;
  assert.notEqual(afterSwitch.ocSessionId,next.ocSessionId);
  assert.ok(afterSwitch.ocPrevSessionIds.includes(next.ocSessionId));
  assert.equal(afterSwitch.ccSessionId,'fixture-other-engine');
  assert.equal(gateway.proc.exitCode,null);
  assert.equal(alternateGateway.proc.exitCode,null);
  assert.equal(await fs.readFile(b.config,'utf8'),bBefore);
  console.log(JSON.stringify({version,acpxVersion,gate:'same_owned_gateway',noProbe:true,hotReloadWithoutRestart:true,
    nativeMcpToolCalled:true,sameNamedSession:true,otherEngineIdPreserved:true,neighborConfigExact:true,
    neighborKeyAbsent:true,warmGatewaySwitchIsolated:true,priorSessionRecorded:true,productionProfile:false,network:'container loopback only'}));
}finally{
  for(const current of [alternateGateway,gateway].filter(Boolean)){
    current.proc.kill('SIGTERM');
    await Promise.race([current.exited,delay(3000)]);
    if(current.proc.exitCode===null)current.proc.kill('SIGKILL');
    if(!toolResults || !alternateCalls)console.error('fixture gateway tail:\n'+current.log().slice(-2200));
  }
  responseServer.closeAllConnections();
  await new Promise(resolve=>responseServer.close(resolve));
}
