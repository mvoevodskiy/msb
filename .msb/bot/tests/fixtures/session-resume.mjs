// Actual Telegram selector -> core runner/placement; fake native stream, real Node cwd probe.
import fs from 'node:fs/promises';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath,pathToFileURL} from 'node:url';
const [provider,scenario]=process.argv.slice(2),source=process.env.FIXTURE_SESSION_SOURCE_ROOT || fileURLToPath(new URL('../../../../',import.meta.url));
if(!['claude','codex'].includes(provider)||!['resume','preparing','existing','same-id','same-first','provider-first','after-reset','after-project'].includes(scenario))throw Error('Unknown resume fixture');
const load=relative=>import(pathToFileURL(path.join(source,relative)));
const cleanup=[],calls=[],results=[],direct=[];let f,savedSpawn,savedRead,releasePrompt=()=>{};
const report={provider,scenario,calls};const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw Error('Fixture timeout: '+label);await wait(2);}}
const watchdog=setTimeout(()=>{console.error('Session resume watchdog');process.exit(2);},10000);
globalThis.fetch=()=>{throw Error('External network forbidden');};
try{
 const {fixture}=await load('.msb/bot/tests/helpers/menu-fixture.mjs');const {runAgentTurn}=await load('.msb/bot/src/agent/turn.mjs');
 const {loadState,saveState,updateState}=await load('.msb/bot/src/state.mjs');
 const {readSessionContext}=await load('.msb/bot/src/agent/context.mjs');
 const {switchProviderSession,currentSessionProvider}=await load('overlay/bot/ext/provider-sessions.mjs');
 f=await fixture({after:fn=>cleanup.push(fn)},async request=>{const out=await runAgentTurn(request);results.push(out);return out;},{overlay:false});
 process.env.CLAUDE_CODE_OAUTH_TOKEN='fixture-only';
 const alpha=path.join(path.dirname(f.workspace),'projects','alpha'),beta=path.join(path.dirname(f.workspace),'projects','beta');
 for(const dir of [alpha,beta]){await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'.current-task.md'),dir===alpha?'fixture-task-alpha':'fixture-task-beta');}
 await fs.writeFile(path.join(f.workspace,'SOUL.md'),'fixture-owner-soul');
 const native=(p,n)=>p==='claude'?'claude-resume-fixture-'+n:'ext:codex:0199a213-81c0-7800-8aa1-'+String(n).padStart(12,'0');
 const old=native(provider,10),foreignProvider=provider==='codex'?'claude':'codex',foreign=native(foreignProvider,90);
 const same=['same-id','same-first'].includes(scenario),targetProvider=scenario==='provider-first'?'claude':provider;
 const target={id:scenario==='same-id'?old:native(targetProvider,20),providerId:targetProvider,engine:'cc',project:same?'alpha':'beta',firstPrompt:'history selected first',messageCount:5,lastActivity:'2026-01-01T00:00:00Z',startedAt:'2026-01-01T00:00:00Z'};
 const existing=['resume','existing','same-id'].includes(scenario);
 const ledger=[...(existing&&target.id!==old?[{...target,id:old,providerId:provider,project:'alpha',firstPrompt:'history old first',messageCount:3}]:[]),target];
 const initial={...(await loadState()).state,engine:'cc',extAuthBypass:provider,ccSessionId:existing?old:undefined,activeProject:'alpha',sessionEpoch:0,lastCcUsage:{sessionId:old,inputTokens:73},sessionHistory:ledger,
  parkedCcSessions:{[foreignProvider]:foreign},pendingCcSessionStarts:{[foreignProvider]:'fixture-other-token'},fixtureKeep:'profile',ccModel:'opus',ccEffort:'high'};
 await saveState(initial);const storeBefore=await fs.readFile(f.storeFile,'utf8');
 if(provider==='codex'){
  const dir=path.join(f.home,'.codex/sessions/2026/11/08');await fs.mkdir(dir,{recursive:true});
  for(const id of new Set([old,target.id].filter(v=>v.startsWith('ext:codex:'))))await fs.writeFile(path.join(dir,'rollout-fixture-'+id.slice(10)+'.jsonl'),JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:50000},model_context_window:475000}}})+'\n');
  report.oldContextMeasured=(await readSessionContext(old))?.contextTokens===50000;
 }
 savedSpawn=cp.spawn;cp.spawn=(command,args,options)=>{
  if(command!=='claude'||options.env.HOME!==f.home)throw Error('Unexpected child');
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const call={args,cwd:options.cwd,provider:options.env.MSB_TURN_PROVIDER,ready:false,closed:false};
  call.actualCwd=cp.execFileSync(process.execPath,['-e','process.stdout.write(process.cwd())'],{cwd:options.cwd,env:{HOME:f.home,PATH:path.dirname(process.execPath)},encoding:'utf8'});
  call.systemPrompt=args[args.indexOf('--append-system-prompt')+1] || '';
  call.respond=id=>{if(call.closed)return;call.closed=true;child.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:id,provider_id:call.provider,model:'fixture-model'})+'\n');child.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:id,is_error:false,result:'fixture-resumed'})+'\n');child.stdout.end();child.stderr.end();child.emit('close',0,null);};
  child.kill=()=>{if(!call.closed){call.closed=true;child.stdout.end();child.stderr.end();child.emit('close',null,'SIGINT');}return true;};
  child.stdin.on('finish',()=>{call.ready=true;});calls.push(call);return child;
 };syncBuiltinESMExports();
 const switchTo=p=>updateState(s=>{switchProviderSession(s,currentSessionProvider(s),p);s.extAuthBypass=p;return s;});
 let held=false;
 if(scenario==='preparing'){
  savedRead=fs.readFile.bind(fs);const gate=new Promise(r=>{releasePrompt=r;});let once=true;
  fs.readFile=async(file,...args)=>{if(once&&String(file)===path.join(f.workspace,'SOUL.md')){once=false;held=true;await gate;}return savedRead(file,...args);};
 }
 if(scenario==='resume'){
  await f.callback('session:'+target.id);report.afterSelect=(await loadState()).state;
  await f.message('fixture selected task');await until(()=>calls[0]?.ready,'resumed child');calls[0].respond(target.id);await until(()=>results.length===1,'resumed result');
 }else if(['after-reset','after-project'].includes(scenario)){
  await f.message('fixture old task');await until(()=>calls[0]?.ready,'old first before reset');
  if(scenario==='after-reset')await f.message('/newtask');else await f.callback('project:beta');
  report.afterTransition=(await loadState()).state;calls[0].respond(old);await until(()=>results.length===1,'returned old history result');report.afterOld=(await loadState()).state;
  await f.callback('session:'+old);report.afterSelect=(await loadState()).state;
  await f.message('fixture selected task');await until(()=>calls[1]?.ready,'explicit old resume');
  const resume=calls[1].args.indexOf('--resume');calls[1].respond(resume>=0&&calls[1].args[resume+1]===old?old:native(provider,40));await until(()=>results.length===2,'explicit resumed result');
  report.target={...target,id:old,providerId:provider,project:'alpha',firstPrompt:'fixture old task',messageCount:1};
 }else if(scenario==='provider-first'){
  await f.message('fixture old task');await until(()=>calls[0]?.ready,'first A');await switchTo('claude');await f.callback('session:'+target.id);report.afterSelect=(await loadState()).state;
  await f.message('/newtask');const next=native('claude',30),job=runAgentTurn({prompt:'fixture new first beta'});direct.push(job);
  await until(()=>calls[1]?.ready,'new first B');const token=(await loadState()).state.pendingCcSessionStarts?.claude;
  calls[0].respond(old);await until(()=>results.length===1,'old first result');report.afterOld=(await loadState()).state;
  report.newReservationSurvived=Boolean(token&&report.afterOld.pendingCcSessionStarts?.claude===token);
  calls[1].respond(next);results.push(await job);await switchTo(provider);report.next=next;
 }else{
  await f.message('fixture old task');if(scenario==='preparing')await until(()=>held,'preparation barrier');else await until(()=>calls[0]?.ready,'old child');
  await f.callback('session:'+target.id);report.afterSelect=(await loadState()).state;releasePrompt();await until(()=>calls[0]?.ready,'captured old child');calls[0].respond(old);
  await until(()=>results.length===1,'old result');report.afterOld=(await loadState()).state;
  await f.message('fixture selected task');await until(()=>calls[1]?.ready,'next resumed child');calls[1].respond(target.id);await until(()=>results.length===2,'next result');
 }
 report.state=(await loadState()).state;report.initial=initial;report.target=report.target || target;report.old=old;report.foreign=foreign;report.foreignProvider=foreignProvider;
 report.alpha=alpha;report.beta=beta;report.realAlpha=await fs.realpath(alpha);report.realBeta=await fs.realpath(beta);report.oldContextCleared=results[0]?.result?.context===null;
 const omit=new Set(['ccSessionId','sessionHistory','lastCcUsage','sessionEpoch','activeProject','parkedCcSessions','pendingCcSessionStarts']);
 const profile=s=>Object.fromEntries(Object.entries(s).filter(([key])=>!omit.has(key)));
 report.profilePreserved=JSON.stringify(profile(report.state))===JSON.stringify(profile(initial));report.providerStorePreserved=await fs.readFile(f.storeFile,'utf8')===storeBefore;
 await f.bot.stop();console.log('SESSION_RESUME='+JSON.stringify(report));
}finally{
 releasePrompt();for(const call of calls)if(!call.closed)call.respond(call.provider==='claude'?'claude-cleanup-fixture':'ext:codex:0199a213-81c0-7800-8aa1-000000000099');
 await Promise.allSettled(direct);await f?.bot.stop();if(savedRead)fs.readFile=savedRead;if(savedSpawn){cp.spawn=savedSpawn;syncBuiltinESMExports();}
 for(const fn of cleanup)await fn();clearTimeout(watchdog);
}
