/** Synthetic local native Claude MCP exercise. Run with loopback-only networking. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const binary=process.argv[2];
assert.ok(typeof binary==='string' && path.isAbsolute(binary),'Pass the installed Claude executable');
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'msb-claude-mcp-')));
const calls=[],requests=[],states=[];
let profile;
const model='claude-sonnet-4-6';
const tool='mcp__apify__fixture_probe';
const server=http.createServer(async (req,res)=>{
  try {
    const route=new URL(req.url,'http://fixture.local').pathname;
    if(req.method!=='POST'){res.writeHead(405).end();return;}
    let text='';for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text);
    if(route.startsWith('/mcp/')){
      const name=route.slice(5);
      const keyOk=name==='managed'?req.headers.authorization==='Bearer '+profile.key:
        name==='override'?req.headers['x-new']==='fixture-new' && !req.headers['x-old']:
        name==='native'?req.headers['x-legacy']==='fixture-native':false;
      calls.push({profile:profile.id,name,method:body.method,keyOk});
      if(!keyOk){res.writeHead(401).end();return;}
      if(body.id===undefined){res.writeHead(202).end();return;}
      const results={
        initialize:{protocolVersion:body.params?.protocolVersion,serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}},
        'tools/list':{tools:[{name:'fixture_probe',description:'Probe fixture',_meta:{'anthropic/alwaysLoad':true},inputSchema:{type:'object',properties:{}}}]},
        'tools/call':{content:[{type:'text',text:'fixture-probed'}]},
      };
      const reply=Object.hasOwn(results,body.method)?{result:results[body.method]}:{error:{code:-32601,message:'fixture method'}};
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:body.id,...reply}));
      return;
    }
    if(route!=='/v1/messages'){res.writeHead(404).end();return;}
    const tools=body.tools?.map(item=>item.name) || [];
    const toolResults=body.messages?.flatMap(item=>Array.isArray(item.content)?item.content:[])
      .filter(part=>part.type==='tool_result').map(part=>part.tool_use_id) || [];
    const sendMcp=tools.includes(tool) && !toolResults.includes('toolu_fixture_mcp');
    const sendWait=!sendMcp && !toolResults.includes('toolu_fixture_mcp') &&
      tools.includes('WaitForMcpServers') && !toolResults.includes('toolu_fixture_wait');
    const useTool=sendMcp || sendWait;
    requests.push({profile:profile.id,offeredTool:tools.includes(tool),waitAvailable:tools.includes('WaitForMcpServers'),
      toolResult:toolResults.includes('toolu_fixture_mcp'),mcpNames:tools.filter(name=>name?.startsWith('mcp__'))});
    const content=useTool?{type:'tool_use',id:sendMcp?'toolu_fixture_mcp':'toolu_fixture_wait',
      name:sendMcp?tool:'WaitForMcpServers',input:{}}:{type:'text',text:'fixture finished'};
    const usage={input_tokens:10,output_tokens:3,cache_creation_input_tokens:0,cache_read_input_tokens:0};
    const reason=useTool?'tool_use':'end_turn';
    const message={id:'msg_fixture',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage};
    if(body.stream!==true){
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({...message,content:[content],stop_reason:reason}));
      return;
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
    send('message_start',{message});
    send('content_block_start',{index:0,content_block:useTool?content:{type:'text',text:''}});
    send('content_block_delta',{index:0,delta:useTool?{type:'input_json_delta',partial_json:'{}'}:{type:'text_delta',text:content.text}});
    send('content_block_stop',{index:0});
    send('message_delta',{delta:{stop_reason:reason,stop_sequence:null},usage:{output_tokens:3}});
    send('message_stop',{});
    res.end();
  }catch{res.writeHead(500).end();}
});
let report;
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+server.address().port;
  const cwd=path.join(root,'workspace'),home=path.join(root,'home');
  await fs.mkdir(cwd);await fs.mkdir(home);
  const nativeFile=path.join(home,'.claude.json'),managedFile=path.join(root,'managed.json');
  const native={
    legacy:{type:'http',url:base+'/mcp/native',headers:{'x-legacy':'fixture-native'}},
    collision:{type:'http',url:base+'/mcp/old',headers:{'x-old':'fixture-old'}},
  };
  await fs.writeFile(nativeFile,JSON.stringify({hasCompletedOnboarding:true,mcpServers:native}),{mode:0o600});
  await fs.writeFile(managedFile,JSON.stringify({mcpServers:{
    apify:{type:'http',url:base+'/mcp/managed',alwaysLoad:true,headers:{Authorization:'Bearer ${MSB_MCP_APIFY_TOKEN}'}},
    collision:{type:'http',url:base+'/mcp/override',headers:{'x-new':'fixture-new'}},
  }}),{mode:0o600});
  const env={HOME:home,CLAUDE_CONFIG_DIR:home,PATH:process.env.PATH,TMPDIR:root,LANG:'C.UTF-8',CI:'1',
    ANTHROPIC_BASE_URL:base,ANTHROPIC_API_KEY:'sk-ant-api03-fixture-only-not-a-real-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',ENABLE_TOOL_SEARCH:'false'};
  const version=execFileSync(binary,['--version'],{env,cwd,encoding:'utf8',timeout:5000}).trim();
  async function run(id,key,deny){
    profile={id,key};
    const argv=['-p','Use the apify fixture tool once, then reply fixture finished.','--verbose','--output-format','stream-json','--model',model,
      '--permission-mode','bypassPermissions','--max-turns','4','--allowedTools','Bash,Read,mcp__apify,mcp__legacy,mcp__collision','--mcp-config',managedFile];
    if(deny)argv.push('--settings',JSON.stringify({deniedMcpServers:[{serverName:'legacy'}]}));
    assert.ok(argv.every(arg=>!arg.includes(key)));
    const child=spawn(binary,argv,{env:{...env,MSB_MCP_APIFY_TOKEN:key},cwd,stdio:['ignore','pipe','ignore']});
    let output='';
    child.stdout.setEncoding('utf8').on('data',chunk=>{if(output.length<300_000)output+=chunk;});
    const watchdog=setTimeout(()=>child.kill('SIGKILL'),25_000);
    let exit;
    try{exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}
    finally{clearTimeout(watchdog);}
    const events=output.split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const result=events.findLast(row=>row.type==='result');
    const summary={id,exit,subtype:result?.subtype,errors:result?.errors?.map(String).map(value=>value.slice(0,80)),
      init:events.find(row=>row.type==='system' && row.subtype==='init')?.mcp_servers?.map(row=>({name:row.name,status:row.status}))};
    states.push(summary);
    assert.equal(exit,0,JSON.stringify(summary));
    assert.equal(result?.is_error,false,JSON.stringify(summary));
    assert.equal(result?.result,'fixture finished',JSON.stringify(summary));
  }
  await run('a','fixture-claude-bot-a',false);
  await run('b','fixture-claude-bot-b',true);
  let toolsCalled=true;
  for(const id of ['a','b']){
    const own=calls.filter(call=>call.profile===id);
    assert.ok(['initialize','tools/list'].every(method=>own.some(row=>row.name==='managed'&&row.method===method&&row.keyOk)),JSON.stringify({version,id,own,requests,states}));
    toolsCalled &&= own.some(row=>row.name==='managed' && row.method==='tools/call' && row.keyOk);
    assert.ok(own.some(row=>row.name==='override'&&row.keyOk));
    assert.ok(!own.some(row=>row.name==='old'));
  }
  assert.ok(toolsCalled,'Both native Claude turns must reach the MCP tool endpoint');
  assert.ok(calls.some(row=>row.profile==='a'&&row.name==='native'&&row.keyOk));
  const denied=calls.every(row=>row.profile!=='b'||row.name!=='native');
  assert.deepEqual(JSON.parse(await fs.readFile(nativeFile,'utf8')).mcpServers,native);
  report={version,profiles:['a','b'],same_native_home:true,template_env_expansion:true,tool_discovery:true,tools_called:toolsCalled,
    native_user_entry_preserved:true,overlay_same_name_replaces_headers:true,
    cli_settings_denial_suppresses_native:denied,model_stub_requests:requests.length,external_model_requests:0,
    original_mcp_definitions_preserved:true,tool_search_disabled_in_fixture:true,stub_received_tool_results:requests.some(row=>row.toolResult)};
}finally{
  if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await fs.rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify({...report,owned_profile_removed:true}));
