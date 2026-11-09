/**
 * Real Telegram enrollment and core/Claude shim/adapter launches, owned fake binaries.
 * [MCP launch preparation](../src/mcp/launch.mjs), [native transport proof](reference/mcp-native-0.166-transport.json).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {mcpFixture} from './helpers/mcp-fixture.mjs';
import {codexManagedMcpName} from '../shared/codex-mcp-name.mjs';
import {runAgentTurn} from '../src/agent/turn.mjs';
import {deleteEnvKey,readEnvMap} from '../src/env/store.mjs';
import {loadState,saveState} from '../src/state.mjs';

const apifyA='apify_api_fixture_launch_a';
const apifyB='apify_api_fixture_launch_b';
const supadata='sd_fixture_launch';
const modelThread='0199a213-81c0-7800-8aa1-bbab2a035a53';
const apifyOverride=(env=process.env)=>'mcp_servers.'+codexManagedMcpName('apify',env)+'={url="https://mcp.apify.com",bearer_token_env_var="MSB_MCP_APIFY_TOKEN"}';
const supadataOverride=()=>'mcp_servers.'+codexManagedMcpName('supadata')+'={url="https://api.supadata.ai/mcp",env_http_headers={"x-api-key"="MSB_MCP_SUPADATA_TOKEN"}}';
const shim=new URL('../../../overlay/bot/ext/shim/run-turn.mjs',import.meta.url).href;

async function nativeFixtures(f) {
  const log=path.join(f.home,'mcp-launch.jsonl');
  const collision=path.join(f.home,'collision');
  const hold=path.join(f.home,'hold-config-read');
  const nativeClaude=path.join(f.home,'native-claude.mjs');
  const bin=path.join(f.home,'.local/bin');
  const configuration={log,collision,hold,nativeCodex:f.native,apifyA,apifyB,supadata,modelThread};
  const claudeSource=`import fs from 'node:fs';
const data=${JSON.stringify(configuration)};
const argv=process.argv.slice(2);
if(argv.includes('--version')){console.log('2.1.154 (Claude Code)');process.exit(0);}
fs.readFileSync(0,'utf8');
const index=argv.indexOf('--mcp-config'),file=index>=0?argv[index+1]:null;
const projection=file?fs.readFileSync(file,'utf8'):null;
fs.appendFileSync(data.log,JSON.stringify({kind:'claude',argv,file,projection,
  mode:file?fs.statSync(file).mode&0o777:null,
  correct:process.env.MSB_MCP_SUPADATA_TOKEN===data.supadata,
  hasDedicated:Boolean(process.env.MSB_MCP_SUPADATA_TOKEN),
  correctApify:process.env.MSB_MCP_APIFY_TOKEN===data.apifyB})+'\\n');
const session_id='fixture-claude-session';
console.log(JSON.stringify({type:'system',subtype:'init',session_id,model:'claude-opus-4-8'}));
console.log(JSON.stringify({type:'result',subtype:'success',session_id,is_error:false,result:'fixture complete',usage:{input_tokens:1,output_tokens:1}}));`;
  const codexSource=`import fs from 'node:fs';
import {createInterface} from 'node:readline';
const data=${JSON.stringify(configuration)};
const argv=process.argv.slice(2);
function record(row){fs.appendFileSync(data.log,JSON.stringify(row)+'\\n');}
function presence(){
 return {apify:Boolean(process.env.MSB_MCP_APIFY_TOKEN),supadata:Boolean(process.env.MSB_MCP_SUPADATA_TOKEN)};
}
if(argv[0]==='app-server'){
 createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.method==='initialize'){console.log(JSON.stringify({id:request.id,result:{}}));return;}
  if(request.method==='initialized')return;
  if(request.method!=='config/read')process.exit(3);
  const occupied=fs.existsSync(data.collision)?fs.readFileSync(data.collision,'utf8').trim():'';
  const config={mcp_servers:occupied?{[occupied]:{url:'https://native.invalid',http_headers:{Authorization:'fixture-native-only'}}}:{}};
  const user={name:{type:'user',file:data.nativeCodex},config};
  record({kind:'codex-read',layers:request.params.includeLayers,pid:process.pid,...presence()});
  if(!request.params.includeLayers && fs.existsSync(data.hold))return;
  console.log(JSON.stringify({id:request.id,result:{config,layers:[user]}}));
 });
}else if(argv[0]==='exec'){
 fs.readFileSync(0,'utf8');
 const apify=process.env.MSB_BOT_ID==='other'?data.apifyB:data.apifyA;
 record({kind:'codex-exec',argv,bot:process.env.MSB_BOT_ID,...presence(),
  correctApify:process.env.MSB_MCP_APIFY_TOKEN===apify,correctSupadata:process.env.MSB_MCP_SUPADATA_TOKEN===data.supadata});
 console.log(JSON.stringify({type:'thread.started',thread_id:data.modelThread}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture complete'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
}else process.exit(4);`;
  await fs.writeFile(nativeClaude,claudeSource,{mode:0o600});
  await fs.writeFile(path.join(bin,'claude'),'#!'+process.execPath+'\nawait import('+JSON.stringify(shim)+');\n',{mode:0o700});
  await fs.writeFile(path.join(bin,'codex'),'#!'+process.execPath+'\n'+codexSource,{mode:0o700});
  process.env.MSB_REAL_CLAUDE=nativeClaude;
  process.env.CLAUDE_CODE_OAUTH_TOKEN='fixture-claude-only';
  process.env.OPENAI_API_KEY='fixture-codex-only';
  delete process.env.CODEX_ACCESS_TOKEN;
  return {
    collision,hold,
    async trace(){return (await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);},
  };
}

async function register(f,name,token) {
  await f.callback('mcp:setup:'+name);
  await f.message(token);
  assert.match(f.messages.at(-1),/подключён/);
}

async function turn() {
  const result=await runAgentTurn({prompt:'owned fixture prompt'});
  assert.equal(result.ok,true,result.text);
}

async function removeApify(f,label='apify') {
  const button=label=>f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat().find(row=>row.text===label)?.callback_data;
  await f.callback('mcp:folder:workspace');
  const card=button(label);
  assert.ok(card);
  await f.callback(card);
  const remove=button('🗑 Удалить');
  assert.ok(remove);
  await f.callback(remove);
}

test('native Claude launch reads the current bot key into a temporary reference-only MCP file',async t=>{
  const f=await mcpFixture(t,'claude'),native=await nativeFixtures(f);
  const original=await fs.readFile(f.config,'utf8');
  await register(f,'supadata',supadata);
  await turn();
  const call=(await native.trace()).at(-1);
  assert.equal(call.kind,'claude');
  assert.equal(call.correct,true);
  assert.equal(call.mode,0o600);
  assert.ok(!call.argv.some(arg=>arg.includes(supadata)));
  assert.ok(!call.projection.includes(supadata));
  assert.deepEqual(JSON.parse(call.projection),{mcpServers:{supadata:{
    type:'http',url:'https://api.supadata.ai/mcp',headers:{'x-api-key':'${MSB_MCP_SUPADATA_TOKEN}'},
  }}});
  await assert.rejects(fs.stat(call.file),{code:'ENOENT'});
  assert.equal(await fs.readFile(f.config,'utf8'),original);
  await deleteEnvKey('SUPADATA_API_KEY');
  process.env.SUPADATA_API_KEY='sd_fixture_inherited_only';
  await turn();
  const missing=(await native.trace()).at(-1);
  assert.equal(missing.file,null);
  assert.equal(missing.hasDedicated,false);
});

test('Codex launch uses each enrolled bot key and stops projecting a removed entry',async t=>{
  const f=await mcpFixture(t,'codex'),native=await nativeFixtures(f);
  const original=await fs.readFile(f.native,'utf8');
  const base=(await loadState()).state,primary=process.env.MSB_BOT_ID;
  const firstOverride=apifyOverride();
  const otherOverride=apifyOverride({...process.env,MSB_BOT_ID:'other'});
  assert.notEqual(firstOverride,otherOverride);
  await register(f,'apify',apifyA);
  await turn();
  process.env.MSB_BOT_ID='other';
  try {
    await saveState(base);
    await register(f,'apify',apifyB);
    await turn();
    await removeApify(f);
    await turn();
  }finally{process.env.MSB_BOT_ID=primary;}
  await turn();
  const executions=(await native.trace()).filter(row=>row.kind==='codex-exec');
  assert.deepEqual(executions.map(row=>[row.bot,row.correctApify,row.argv.includes(row.bot===primary?firstOverride:otherOverride)]),[
    [primary,true,true],['other',true,true],['other',false,false],[primary,true,true],
  ]);
  assert.ok(executions.every(row=>!row.argv.some(arg=>arg.includes(apifyA)||arg.includes(apifyB))));
  assert.equal(await fs.readFile(f.native,'utf8'),original);
});

test('Codex checks effective native names before passing isolated credentials to exec',async t=>{
  const f=await mcpFixture(t,'codex'),native=await nativeFixtures(f);
  await register(f,'apify',apifyA);
  await register(f,'supadata',supadata);
  await fs.writeFile(native.collision,codexManagedMcpName('apify'));
  await turn();
  const trace=await native.trace();
  const probe=trace.find(row=>row.kind==='codex-read' && !row.layers);
  const execution=trace.at(-1);
  assert.ok(probe);
  assert.equal(probe.apify,false);
  assert.equal(probe.supadata,false);
  assert.ok(!execution.argv.includes(apifyOverride()));
  assert.ok(execution.argv.includes(supadataOverride()));
  assert.equal(execution.apify,false);
  assert.equal(execution.correctSupadata,true);
});


test('enrolling the same service in Claude and Codex keeps both launch credentials',async t=>{
  const f=await mcpFixture(t,'codex'),native=await nativeFixtures(f);
  await register(f,'apify',apifyA);
  await f.callback('ext:conn:set:claude');
  assert.ok(!(await loadState()).state.extAuthBypass);
  await register(f,'apify',apifyB);
  const {map}=await readEnvMap();
  assert.equal(map.get('APIFY_API_KEY'),apifyA,'Claude enrollment must preserve the previously saved Codex key');
  assert.equal(map.get('APIFY_API_KEY_CLAUDE'),apifyB);
  await turn();
  assert.equal((await native.trace()).at(-1).correctApify,true);
  const {state}=await loadState();
  assert.ok(!JSON.stringify(state).includes(apifyA) && !JSON.stringify(state).includes(apifyB));
  await saveState({...state,extAuthBypass:'codex'});
  await turn();
  const call=(await native.trace()).at(-1);
  assert.equal(call.kind,'codex-exec');
  assert.equal(call.correctApify,true);
});


test('stopping the turn also stops its pending native MCP config read',async t=>{
  const f=await mcpFixture(t,'codex'),native=await nativeFixtures(f);
  await register(f,'apify',apifyA);
  await fs.writeFile(native.hold,'hold the startup read');
  const controller=new AbortController();
  const job=runAgentTurn({prompt:'owned abort fixture',signal:controller.signal});
  let probe;
  try {
    const deadline=Date.now()+3000;
    while(!probe){
      probe=(await native.trace()).find(row=>row.kind==='codex-read' && !row.layers);
      assert.ok(Date.now()<deadline,'The launch must reach its native config guard');
      if(!probe)await new Promise(resolve=>setTimeout(resolve,5));
    }
    controller.abort();
    const result=await job;
    assert.equal(result.error,'aborted');
    assert.ok(!(await native.trace()).some(row=>row.kind==='codex-exec'));
    const stopDeadline=Date.now()+2000;
    for(;;){
      try{process.kill(probe.pid,0);}
      catch(error){assert.equal(error.code,'ESRCH');break;}
      assert.ok(Date.now()<stopDeadline,'The guard process must stop with its turn');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  }finally{
    controller.abort();
    await Promise.allSettled([job]);
  }
});


test('a same-name native Codex entry keeps its own card and the bot entry still launches and deletes independently',async t=>{
  const f=await mcpFixture(t,'codex'),native=await nativeFixtures(f);
  await register(f,'apify',apifyA);
  await fs.writeFile(native.collision,'apify');
  await f.callback('mcp:folder:workspace');
  const buttons=f.editOptions.at(-1).reply_markup.inline_keyboard.flat();
  const normal=buttons.find(row=>row.text==='apify');
  const managed=buttons.find(row=>row.text==='apify (бот)');
  assert.ok(normal && managed);
  assert.notEqual(normal.callback_data,managed.callback_data);
  await f.callback(normal.callback_data);
  assert.ok(f.edits.at(-1).includes('mcp__apify__*'));
  assert.ok(!f.editOptions.at(-1).reply_markup.inline_keyboard.flat().some(row=>row.text==='🗑 Удалить'));
  await f.callback(managed.callback_data);
  assert.ok(f.edits.at(-1).includes('mcp__'+codexManagedMcpName('apify')+'__*'));
  await turn();
  const call=(await native.trace()).at(-1);
  assert.ok(call.argv.includes(apifyOverride()));
  assert.ok(!call.argv.some(arg=>arg.startsWith('mcp_servers.apify=')));
  await removeApify(f,'apify (бот)');
  const names=f.editOptions.at(-1).reply_markup.inline_keyboard.flat().map(row=>row.text);
  assert.ok(names.includes('apify'));
  assert.ok(!names.includes('apify (бот)'));
  assert.equal((await readEnvMap()).map.get('APIFY_API_KEY'),apifyA);
});

test('an occupied Codex bot key does not accept credentials or advertise setup',async t=>{
  const f=await mcpFixture(t,'codex'),native=await nativeFixtures(f);
  await fs.writeFile(native.collision,codexManagedMcpName('apify'));
  await f.callback('mcp:setup:apify');
  await f.message(apifyA);
  assert.match(f.messages.at(-1),/уже настроен в профиле/);
  assert.ok(!(await readEnvMap()).map.has('APIFY_API_KEY'));
  await f.callback('mcp:add');
  const names=f.editOptions.at(-1).reply_markup.inline_keyboard.flat().map(row=>row.text);
  assert.ok(!names.includes('Apify'));
  assert.ok(names.includes('Supadata'));
});
