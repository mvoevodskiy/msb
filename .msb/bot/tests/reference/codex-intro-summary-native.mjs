/** Synthetic isolated native Codex CLI summary via loopback-only model fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [binary, source] = process.argv.slice(2);
assert.ok(path.isAbsolute(binary) && path.isAbsolute(source));
const {prepareIntroductionSummary} = await import(pathToFileURL(path.join(source,'overlay/bot/ext/intro-summary-policy.mjs')));
const {buildCodexExecArgs,runCodexTurn} = await import(pathToFileURL(path.join(source,'overlay/bot/ext/adapters/codex.mjs')));
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'msb-intro-native-')));
const home=path.join(root,'home'), native=path.join(root,'profile'), cwd=path.join(root,'workspace'), bin=path.join(root,'bin');
const marker=path.join(root,'forbidden-mcp-started');
const schema=path.join(source,'.msb/bot/src/agent/intro-summary.schema.json');
const access='fixture-loopback-oauth';
const jwt='eyJhbGciOiJub25lIn0.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64url')+'.fixture';
let phase='seed', failure, calls=0; const inventory={};
const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/v1/responses')return res.writeHead(404).end();
  try {
    assert.equal(req.headers.authorization,'Bearer '+access);
    let data='';for await(const part of req)data+=part;const input=JSON.parse(data);calls++;
    const tools=(input.tools||[]).flatMap(tool=>tool.type==='namespace'?tool.tools.map(child=>child.name):[tool.name||tool.type]);
    inventory[phase]=tools;
    const summary='{"version":1,"save":true,"user":["Example owner"],"memory":["Example preference"]}';
    const item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:phase==='seed'?'Fixture introduction':summary,annotations:[]}]};
    if(phase==='summary') assert.ok(JSON.stringify(input).includes('"json_schema"'),'summary must request structured JSON');
    const response={id:'resp_fixture_'+calls,created_at:1,model:'gpt-5.4',status:'completed',output:[item]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [type,value] of [['response.created',{response:{...response,status:'in_progress',output:[]}}],['response.output_item.done',{output_index:0,item}],['response.completed',{response}]])
      res.write('event: '+type+'\ndata: '+JSON.stringify({type,...value})+'\n\n');
    res.end();
  } catch(e) {failure=e;res.writeHead(500).end();}
});
const invoke=(args,env,prompt)=>new Promise((resolve,reject)=>{
  const child=execFile(binary,args,{cwd,env,timeout:45_000,maxBuffer:2*1024*1024},(err,stdout,stderr)=>err?reject(failure||Error(stderr.slice(-1500))):resolve(stdout));
  child.stdin.on('error',()=>{});child.stdin.end(prompt);
});
try {
  await Promise.all([home,native,cwd,bin].map(dir=>fs.mkdir(dir,{recursive:true,mode:0o700})));
  await fs.symlink(binary,path.join(bin,'codex'));
  await fs.writeFile(path.join(native,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:jwt,access_token:access,refresh_token:'fixture',account_id:'fixture-account'},last_refresh:new Date().toISOString()}),{mode:0o600});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const config='model = "gpt-5.4"\nmodel_reasoning_effort = "high"\nmodel_provider = "fixture"\n'+
    '[model_providers.fixture]\nname = "loopback fixture"\nbase_url = "http://127.0.0.1:'+server.address().port+'/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n'+
    '[mcp_servers.foreign]\ncommand = "/bin/sh"\nargs = ["-c", '+JSON.stringify('touch "'+marker+'"')+']\n';
  await fs.writeFile(path.join(native,'config.toml'),config);
  const env={HOME:home,CODEX_HOME:native,PATH:bin+path.delimiter+process.env.PATH,LANG:'C.UTF-8',MSB_BOT_ID:'default',
    MSB_CODEX_INTRO_SUMMARY:'1',MSB_CODEX_INTRO_SCHEMA:schema,NO_PROXY:'127.0.0.1,localhost'};
  const plan=await prepareIntroductionSummary({command:binary,cwd,env,schemaFile:schema});
  assert.equal(plan.ok,true);
  assert.ok(plan.args.some(arg=>arg.includes('mcp_servers={"foreign"={enabled=false}}')));
  const seed=await invoke(buildCodexExecArgs({model:'gpt-5.4',forceHttp:false,summaryArgs:plan.args}),env,'Fixture introduction.');
  const thread=seed.trim().split('\n').map(JSON.parse).find(event=>event.type==='thread.started')?.thread_id;
  assert.ok(thread);
  phase='summary';
  const result=await runCodexTurn({prompt:'Return permitted structured fixture facts.',parsed:{resume:'ext:codex:'+thread},cwd,env,home});
  if(failure)throw failure;
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.nativeSessionId,thread);
  assert.deepEqual(JSON.parse(result.text),{version:1,save:true,user:['Example owner'],memory:['Example preference']});
  assert.equal(await fs.readFile(path.join(native,'config.toml'),'utf8'),config);
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  const forbidden=/exec_command|write_stdin|shell|apply_patch|view_image|imagegen|[a-z]_goal|foreign|browser|computer/;
  assert.equal(inventory.summary.some(name=>forbidden.test(name)),false,JSON.stringify(inventory.summary));
  assert.equal(calls,2);
  console.log(JSON.stringify({native_session_resumed:true,structured_output:true,foreign_mcp_disabled:true,
    no_action_tools:true,config_unchanged:true,model:'loopback fixture',tools:inventory.summary}));
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});}
