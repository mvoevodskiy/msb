/** Isolated pinned CLI handshake. Inputs are synthetic. Run with only loopback networking. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';

const binary=process.argv[2];
assert.ok(binary && path.isAbsolute(binary),'Pass an absolute path to Codex 0.166.0');
const version='codex-cli 0.166.0';
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'msb-mcp-transport-')));
const turnMethods=['initialize','tools/list','tools/call'];
const headerChecks=[],modelRequests=[];
let active;
const fixture=http.createServer(async(req,res)=>{
  try {
    if(req.url?.startsWith('/v1/')) {
      modelRequests.push({method:req.method,path:req.url});
      res.writeHead(404).end();
      return;
    }
    if(req.url!=='/mcp' || req.method!=='POST'){
      res.writeHead(405).end();
      return;
    }
    let text='';
    for await(const part of req)text+=part;
    const msg=JSON.parse(text);
    const bearer=req.headers.authorization==='Bearer '+active.bearer;
    const key=req.headers['x-api-key']===active.key;
    headerChecks.push({profile:active.id,method:msg.method,bearer,key});
    if(!bearer || !key){res.writeHead(401).end();return;}
    if(msg.id===undefined){res.writeHead(202).end();return;}
    const outcomes={
      initialize:{protocolVersion:msg.params?.protocolVersion,serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}},
      'tools/list':{tools:[{name:'fixture_probe',description:'Fixture tool',inputSchema:{type:'object',properties:{}}}]},
      'tools/call':{content:[{type:'text',text:'fixture-tool-result'}],isError:false},
    };
    const reply=Object.hasOwn(outcomes,msg.method)?{result:outcomes[msg.method]}:{error:{code:-32601,message:'fixture method'}};
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:msg.id,...reply}));
  }catch{res.writeHead(500).end();}
});
try {
  await new Promise((resolve,reject)=>{fixture.once('error',reject);fixture.listen(0,'127.0.0.1',resolve);});
} catch(error) {
  await fs.rm(root,{recursive:true,force:true});
  throw error;
}
const base='http://127.0.0.1:'+fixture.address().port;
const cwd=path.join(root,'workspace'),home=path.join(root,'home'),native=path.join(root,'codex');
const config=path.join(native,'config.toml');
const source=[
  'model_provider = "fixture"',
  'model = "gpt-5.4"',
  '[model_providers.fixture]','name = "Local fixture"',
  'base_url = '+JSON.stringify(base+'/v1'),'wire_api = "responses"',
  'request_max_retries = 0','stream_max_retries = 0',
  '[mcp_servers.collision]','url = '+JSON.stringify(base+'/legacy'),
  'enabled = false','http_headers = {"x-legacy" = "fixture-legacy-header"}','',
].join('\n');
const common={HOME:home,CODEX_HOME:native,PATH:process.env.PATH,LANG:'C.UTF-8',TMPDIR:root};

async function runApp(overrides,profile,action) {
  const env={...common};
  if(profile){env.FIXTURE_BEARER=profile.bearer;env.FIXTURE_API_KEY=profile.key;}
  const argv=[...overrides.flatMap(value=>['-c',value]),'app-server'];
  assert.ok(!profile || !argv.some(value=>value.includes(profile.bearer) || value.includes(profile.key)));
  const child=spawn(binary,argv,{cwd,env,detached:true,stdio:['pipe','pipe','ignore']});
  const wire=createInterface({input:child.stdout});
  const pending=new Map();
  let next=1,leaderExited=false;
  child.once('exit',()=>{leaderExited=true;});
  const closed=new Promise(resolve=>{
    child.on('error',resolve);
    child.on('close',resolve);
  });
  function send(value){child.stdin.write(JSON.stringify(value)+'\n');}
  function request(method,params) {
    const id=next++;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error(method+' timed out')),12_000);
      pending.set(id,{resolve,reject,timeout,method});
      send({id,method,params});
    });
  }
  child.stdin.on('error',()=>{});
  wire.on('line',line=>{
    let msg;try{msg=JSON.parse(line);}catch{return;}
    const item=pending.get(msg?.id);
    if(!item || msg?.method)return;
    clearTimeout(item.timeout);pending.delete(msg.id);
    if(msg.error)item.reject(Error(item.method+' RPC error '+msg.error.code));
    else item.resolve(msg.result);
  });
  const kill=()=>{
    if(!leaderExited && child.pid && child.exitCode==null && child.signalCode==null){
      try{process.kill(-child.pid,'SIGKILL');}catch{}
    }
  };
  try {
    await request('initialize',{clientInfo:{name:'msb_mcp_transport_probe',version:'1'}});
    send({method:'initialized'});
    return await action(request);
  }finally{
    child.stdin.end();
    const timer=setTimeout(kill,2000);
    let observer;
    await Promise.race([closed,new Promise(resolve=>{observer=setTimeout(resolve,3000);})]);
    clearTimeout(timer);clearTimeout(observer);
    child.stdin.destroy();child.stdout.destroy();child.unref();
    for(const item of pending.values())clearTimeout(item.timeout);
    wire.close();
  }
}

const a={id:'a',bearer:'fixture-bearer-a',key:'fixture-api-a'};
const b={id:'b',bearer:'fixture-bearer-b',key:'fixture-api-b'};
const projected='mcp_servers.probe={url='+JSON.stringify(base+'/mcp')+
  ',bearer_token_env_var="FIXTURE_BEARER",env_http_headers={"x-api-key"="FIXTURE_API_KEY"}}';
async function tools(profile,overrides,call) {
  active=profile;
  return runApp(overrides,profile,async request=>{
    const thread=(await request('thread/start',{cwd,ephemeral:true})).thread;
    assert.ok(thread?.id);
    const status=await request('mcpServerStatus/list',{threadId:thread.id,detail:'toolsAndAuthOnly'});
    assert.ok(Array.isArray(status.data));
    const server=status.data.find(row=>row.name==='probe');
    if(!call){assert.equal(server,undefined);return;}
    assert.ok(server?.tools?.fixture_probe,'The native tool must be discovered');
    const result=await request('mcpServer/tool/call',{threadId:thread.id,server:'probe',tool:'fixture_probe',arguments:{}});
    assert.equal(result.content?.[0]?.text,'fixture-tool-result');
    assert.notEqual(result.isError,true);
  });
}
let proof;
try {
  await fs.mkdir(cwd);await fs.mkdir(home);await fs.mkdir(native);
  await fs.writeFile(config,source,{mode:0o600});
  assert.equal(execFileSync(binary,['--version'],{cwd,env:common,encoding:'utf8',timeout:5000}).trim(),version);
  await tools(a,[projected],true);
  await tools(b,[projected],true);
  const beforeRemove=headerChecks.length;
  await tools(a,[],false);
  assert.equal(headerChecks.length,beforeRemove);
  await tools(b,[projected],true);
  for(const profile of [a,b]){
    const observed=headerChecks.filter(row=>row.profile===profile.id);
    assert.ok(turnMethods.every(method=>observed.some(row=>row.method===method && row.bearer && row.key)));
    assert.ok(observed.every(row=>row.bearer && row.key));
  }
  const retained=await runApp(['mcp_servers.collision={url='+JSON.stringify(base+'/replacement')+',http_headers={}}'],null,async request=>{
    const view=await request('config/read',{cwd,includeLayers:false});
    return view.config?.mcp_servers?.collision?.http_headers?.['x-legacy']==='fixture-legacy-header';
  });
  assert.ok(retained,'Native same-name overrides merge lower-layer header fields');
  assert.equal(await fs.readFile(config,'utf8'),source);
  await assert.rejects(fs.stat(path.join(native,'auth.json')),{code:'ENOENT'});
  assert.equal(modelRequests.filter(row=>row.path.includes('responses')).length,0);
  proof={version,profiles:['a','b'],same_native_home:true,
    native_methods:turnMethods,correct_headers_for_each_profile:true,other_profile_after_removal:true,
    missing_override_no_connection:true,native_config_byte_exact:true,same_name_keeps_existing_headers:retained,
    auth_present:false,model_turns:0,model_endpoint_requests:modelRequests.length};
}finally{
  fixture.closeAllConnections();
  await new Promise(resolve=>fixture.close(resolve));
  await fs.rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify({...proof,owned_profile_removed:true}));
