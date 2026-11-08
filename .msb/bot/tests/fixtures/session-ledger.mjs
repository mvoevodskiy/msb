// Real core runner/state placement; no Telegram transport, native model or network.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
const [provider,scenario]=process.argv.slice(2);
const home=await fs.mkdtemp(path.join(os.tmpdir(),'msb-session-ledger-')),workspace=path.join(home,'workspace');
const id=n=>provider==='claude'?'claude-ledger-'+n:'ext:codex:0199a213-81c0-7800-8aa1-'+String(n).padStart(12,'0');
const calls=[],controller=new AbortController(),watchdog=setTimeout(()=>{console.error('Ledger fixture timeout');process.exit(2);},7000);
for(const key of Object.keys(process.env))delete process.env[key];
Object.assign(process.env,{HOME:home,PATH:path.dirname(process.execPath),MSB_WORKSPACE_DIR:workspace,MSB_BOT_ID:'default',CLAUDE_CODE_OAUTH_TOKEN:'fixture-only'});
globalThis.fetch=()=>{throw Error('External network forbidden');};
try{
 await fs.mkdir(workspace);for(const name of ['alpha','beta'])await fs.mkdir(path.join(home,'projects',name),{recursive:true});
 const {fixtureClaudeVersion}=await import('../helpers/claude-version-fixture.mjs');await fixtureClaudeVersion(home,'2.1.316');
 const {runAgentTurn}=await import('../../src/agent/turn.mjs');const {loadState,saveState,updateState}=await import('../../src/state.mjs');
 const {invalidateFirstSession}=await import('../../shared/session-starts.mjs');
 const {switchProviderSession,currentSessionProvider}=await import('../../../../overlay/bot/ext/provider-sessions.mjs');
 const {applyProjectSelection}=await import('../../src/projects/selection.mjs');
 const seedRow=n=>({id:id(n),engine:'cc',providerId:provider,project:'alpha',firstPrompt:'seed-first-'+n,startedAt:'2026-01-01T00:00:00Z',lastActivity:'2026-01-01T00:00:00Z',messageCount:3});
 const initial={engine:'cc',extAuthBypass:provider,activeProject:'alpha',sessionEpoch:0,ccModel:'opus',fixturePreserved:true};
 if(['error-existing','abort-existing','update-order','foreign-existing','sentinel-existing'].includes(scenario)){initial.ccSessionId=id(10);initial.sessionHistory=[seedRow(10),seedRow(11)];}
 if(scenario==='limit'){initial.ccSessionId=id(99);initial.sessionHistory=Array.from({length:100},(_,i)=>seedRow(i));}
 if(scenario==='throws')initial.activeProject='missing';
 await saveState(initial);
 cp.spawn=(command,args,opts)=>{
  if(command!=='claude'||opts.env.HOME!==home)throw Error('Unexpected model process');
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();let closed=false;
  const call={cwd:opts.cwd,provider:opts.env.MSB_TURN_PROVIDER,prompt:''};calls.push(call);
  const close=(code=0)=>{if(closed)return;closed=true;child.stdout.end();child.stderr.end();child.emit('close',code,null);};
  child.kill=()=>{close();return true;};child.stdin.on('data',chunk=>{call.prompt+=chunk;});
  child.stdin.on('finish',()=>queueMicrotask(async()=>{
   try{
    if(scenario==='provider-away')await updateState(s=>{switchProviderSession(s,currentSessionProvider(s),'claude');s.extAuthBypass='claude';return s;});
    if(scenario==='reset')await updateState(s=>{invalidateFirstSession(s);delete s.ccSessionId;s.sessionEpoch++;return s;});
    if(scenario==='project-reset')await updateState(s=>applyProjectSelection(s,'beta'));
    const native=scenario.startsWith('sentinel')?(provider==='claude'?'unknown':'ext:codex:norestart'):scenario.startsWith('foreign')?'ext:qwen:foreign-ledger-session':scenario==='limit'?id(201):id(10);
    const actual=scenario.startsWith('foreign')?'qwen':provider;
    child.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:native,provider_id:actual,model:'fixture-model'})+'\n');
    if(scenario.startsWith('abort-')){controller.abort();return;}
    if(scenario==='tool-only')child.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{file_path:'fixture'}}]}})+'\n');
    const failure=scenario.startsWith('error-');
    child.stdout.write(JSON.stringify({type:'result',subtype:failure?'error':'success',session_id:native,is_error:failure,result:scenario==='tool-only'?'':'fixture-ledger-answer'})+'\n');close(failure?1:0);
   }catch(error){console.error(error);close(1);}
  }));return child;
 };
 syncBuiltinESMExports();
 let prompt=scenario==='redaction'?'fixture api_key=sk-session-fixture-secret-1234567890':scenario==='bounded'?'x'.repeat(350):'fixture first prompt';
 let out;try{out=await runAgentTurn({prompt,signal:controller.signal,autonomy:scenario==='autonomy'});}catch(error){out={ok:false,error:error.code||'exception'};}
 if(['repeat','update-order'].includes(scenario))out=await runAgentTurn({prompt:'fixture latest prompt',signal:controller.signal});
 const state=(await loadState()).state;
 console.log('SESSION_LEDGER='+JSON.stringify({provider,scenario,initial,state,calls,ok:out.ok,error:out.error,project:path.join(home,'projects','alpha'),id:id(10),newId:id(201),secondOldId:id(1)}));
}finally{clearTimeout(watchdog);controller.abort();await fs.rm(home,{recursive:true,force:true});}
