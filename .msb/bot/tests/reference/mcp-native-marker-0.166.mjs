/** Actual Codex 0.166 named profile and normal exec. Run inside a loopback-only namespace. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {stageCodexMcp} from '../../shared/codex-mcp-profile.mjs';
import {codexManagedMcpName} from '../../shared/codex-mcp-name.mjs';
import {prepareCodexMcp} from '../../../../overlay/bot/ext/codex-mcp-launch.mjs';

const binary=process.argv[2];
assert.ok(path.isAbsolute(binary));
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'msb-native-marker-')));
const home=path.join(root,'home'),native=path.join(root,'codex'),cwd=path.join(root,'workspace');
const config=path.join(native,'config.toml'),childLog=path.join(root,'stdio.jsonl'),childScript=path.join(root,'stdio.cjs');
const env={HOME:home,CODEX_HOME:native,PATH:process.env.PATH,LANG:'C.UTF-8',TMPDIR:root,MSB_BOT_ID:'a'};
function call(args,options={}){
  return new Promise((resolve,reject)=>{
    const child=execFile(binary,args,{cwd,env,timeout:15_000,maxBuffer:4*1024*1024,...options},(error,stdout,stderr)=>{
      if(error)reject(error);
      else resolve({stdout,stderr});
    });
    child.stdin.on('error',()=>{});
    child.stdin.end();
  });
}
const incoming=[],header='Bearer fixture-private-profile-header',argument='fixture-private-stdio-arg';
const tools=[{name:'probe',description:'Isolated marker probe',inputSchema:{type:'object',properties:{}}}];
const httpAlias=codexManagedMcpName('custom-http',env),stdioAlias=codexManagedMcpName('custom-stdio',env);
const available=[httpAlias,stdioAlias];
const toolResults=['fixture-http-result','fixture-stdio-result'];
let installing=false,modelRequests=0,receivedResults=0,nativeConnections=0,fixtureFailure;
const fixture=http.createServer(async(req,res)=>{
  try{
    if(req.url==='/native-mcp'){nativeConnections++;res.writeHead(400).end();return;}
    if(req.method!=='POST'){res.writeHead(404).end();return;}
    let body='';for await(const chunk of req)body+=chunk;
    const input=JSON.parse(body);
    if(req.url==='/v1/responses'){
      const step=installing?modelRequests++:0;
      if(installing && step>0){
        const output=input.input?.find(row=>row.type==='function_call_output' && row.call_id==='call_fixture_'+(step-1));
        assert.ok(JSON.stringify(output)?.includes(toolResults[step-1]),'Model stub must receive the previous MCP tool result');
        receivedResults++;
      }
      let item;
      if(installing && step<available.length){
        const alias=available[step].replaceAll('-','_');
        const direct=input.tools?.find(tool=>tool.name?.replaceAll('-','_').includes(alias) && tool.type==='function');
        const group=input.tools?.find(tool=>tool.name?.replaceAll('-','_').includes(alias) && tool.type==='namespace');
        const tool=direct ?? group?.tools?.find(tool=>tool.name?.endsWith('probe'));
        assert.ok(tool,'The MCP tool must be offered. Tool identifiers: '+JSON.stringify(input.tools?.map(row=>[row.type,row.name])));
        item={id:'fc_fixture_'+step,type:'function_call',name:tool.name,arguments:'{}',
          ...(group && !direct?{namespace:group.name}:{}),call_id:'call_fixture_'+step,status:'completed'};
      }else{
        item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:installing?'fixture complete':'fixture seed',annotations:[]}]};
      }
      const response={id:installing?'resp_fixture_'+step:'resp_seed',created_at:1,model:'msb-local-fixture',status:'completed',output:[item]};
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const [type,value] of [
        ['response.created',{response:{...response,status:'in_progress',output:[]}}],
        ['response.output_item.done',{output_index:0,item}],
        ['response.completed',{response}],
      ])res.write('event: '+type+'\ndata: '+JSON.stringify({type,...value})+'\n\n');
      res.end();return;
    }
    if(req.url!=='/mcp?route=owned-fixture' || req.headers.authorization!==header || req.headers['x-other']!=='fixture-other'){
      res.writeHead(401).end();return;
    }
    incoming.push(input.method);
    if(input.id===undefined){res.writeHead(202).end();return;}
    const result=input.method==='initialize'?{
      protocolVersion:input.params?.protocolVersion,serverInfo:{name:'marker-http',version:'1'},capabilities:{tools:{}},
    }:input.method==='tools/list'?{tools}:{content:[{type:'text',text:'fixture-http-result'}],isError:false};
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:input.id,result}));
  }catch(error){fixtureFailure=error;res.writeHead(500).end();}
});

let prepared,proof;
try{
  await Promise.all([home,native,cwd].map(dir=>fs.mkdir(dir,{mode:0o700})));
  const {stdout}=await call(['--version']);
  assert.equal(stdout.trim(),'codex-cli 0.166.0');
  await new Promise((resolve,reject)=>{fixture.once('error',reject);fixture.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+fixture.address().port;
  await fs.writeFile(childScript,[
    'const fs=require("node:fs");const {createInterface}=require("node:readline");',
    'const [log,arg]=process.argv.slice(2);',
    'const tools='+JSON.stringify(tools)+';',
    'createInterface({input:process.stdin}).on("line",line=>{',
    ' const msg=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({method:msg.method,arg})+"\\n");',
    ' if(msg.id===undefined)return;',
    ' const result=msg.method==="initialize"?{protocolVersion:msg.params?.protocolVersion,serverInfo:{name:"marker-stdio",version:"1"},capabilities:{tools:{}}}:msg.method==="tools/list"?{tools}:{content:[{type:"text",text:"fixture-stdio-result"}],isError:false};',
    ' console.log(JSON.stringify({jsonrpc:"2.0",id:msg.id,result}));',
    '});',
  ].join('\n'),{mode:0o600});
  const controlSource=[
    'model_provider = "local_fixture"','model = "msb-local-fixture"',
    '[model_providers.local_fixture]','name = "Local test"','wire_api = "responses"',
    'base_url = '+JSON.stringify(base+'/v1'),'request_max_retries = 0','stream_max_retries = 0',
    '[mcp_servers.control]','command = '+JSON.stringify(process.execPath),
    'args = '+JSON.stringify([childScript,childLog,'control-only']),'',
  ].join('\n');
  const nativeArgs=['exec','--json','--skip-git-repo-check','--sandbox','danger-full-access'];
  const threadId=output=>output.split('\n').filter(Boolean).map(JSON.parse)
    .find(event=>event.type==='thread.started')?.thread_id;
  await fs.writeFile(config,controlSource,{mode:0o600});
  const seed=await call([...nativeArgs,'Owned conversation before installation']).catch(error=>{throw fixtureFailure ?? error;});
  assert.match(seed.stdout,/fixture seed/);
  const priorThread=threadId(seed.stdout);
  assert.ok(priorThread);
  installing=true;
  const original=controlSource+['[mcp_servers.custom-http]','url = '+JSON.stringify(base+'/native-mcp'),'required = true',''].join('\n');
  await fs.writeFile(config,original,{mode:0o600});
  prepared=await stageCodexMcp([
    {name:'custom-http',config:{type:'http',url:base+'/mcp?route=owned-fixture',headers:{Authorization:header,'X-Other':'fixture-other'}}},
    {name:'custom-stdio',config:{type:'stdio',command:process.execPath,args:[childScript,childLog,argument]}},
  ],cwd,env);
  const removal={scope:config,names:['custom-http']};
  const projection=await prepareCodexMcp(binary,cwd,{...env,MSB_TURN_MCP_CUSTOM:JSON.stringify(prepared.codexCustom),
    MSB_TURN_MCP_REMOVE:JSON.stringify(removal)});
  assert.equal(projection.blocked,undefined);
  assert.equal(projection.env.MSB_TURN_MCP_CUSTOM,undefined);
  assert.deepEqual(projection.args,['-c','mcp_servers={"custom-http"={enabled=false}}','--profile',prepared.codexCustom.name]);
  assert.ok(!projection.args.join(' ').includes(header) && !projection.args.join(' ').includes(argument));
  const names=async (args,childEnv=env)=>JSON.parse((await call([...args,'mcp','list','--json'],{env:childEnv})).stdout)
    .filter(row=>row.enabled!==false).map(row=>row.name).sort();
  assert.deepEqual(await names(projection.args),['control',httpAlias,stdioAlias].sort());
  assert.deepEqual(await names([],{...env,MSB_BOT_ID:'b'}),['control','custom-http'].sort());
  const nativeBeforeExec=nativeConnections;
  const result=await call([...nativeArgs,...projection.args,'resume',priorThread,'Owned local MCP fixture'],
    {env:projection.env}).catch(error=>{throw fixtureFailure ?? error;});
  if(fixtureFailure)throw fixtureFailure;
  assert.match(result.stdout,/fixture complete/);
  assert.equal(threadId(result.stdout),priorThread);
  assert.equal(modelRequests,3);
  assert.equal(receivedResults,2);
  assert.equal(nativeConnections,nativeBeforeExec,'The selected bot must not connect to the replaced native server during exec');
  assert.ok(['initialize','tools/list','tools/call'].every(method=>incoming.includes(method)));
  const rows=(await fs.readFile(childLog,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row=>row.arg===argument && row.method==='tools/list'));
  assert.ok(rows.some(row=>row.arg===argument && row.method==='tools/call'));
  assert.ok(rows.some(row=>row.arg==='control-only' && row.method==='tools/list'));
  assert.equal(await fs.readFile(config,'utf8'),original);
  await prepared.close();
  await assert.rejects(fs.lstat(path.join(native,prepared.codexCustom.name+'.config.toml')),{code:'ENOENT'});
  proof={version:stdout.trim(),normal_exec:true,resumed_same_thread:true,http_headers_and_query_verified:true,stdio_arguments_verified:true,
    both_tools_called:true,original_name_disabled_for_this_bot:true,
    shared_config_exact:true,sibling_native_names_preserved:true,profile_removed:true,network:'loopback-only',production_auth:false};
}finally{
  await prepared?.close();
  if(fixture.listening){fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));}
  await fs.rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify(proof));
