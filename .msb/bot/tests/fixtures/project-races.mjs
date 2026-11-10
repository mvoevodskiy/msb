// Production bot/runner/provider state, fake Telegram/model; real harmless Node cwd probe.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath,pathToFileURL} from 'node:url';
const source=process.env.FIXTURE_PROJECT_SOURCE_ROOT || fileURLToPath(new URL('../../../../',import.meta.url));
const scenario=process.argv[2],load=relative=>import(pathToFileURL(path.join(source,relative)));
if(!['preparing','existing','first-provider'].includes(scenario))throw Error('Unknown project race');
const cleanup=[],calls=[],results=[],direct=[];let f,releasePrompt=()=>{},savedRead,savedSpawn;
const report={scenario,calls};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw Error('Fixture timeout: '+label);await wait(2);}}
const watchdog=setTimeout(()=>{console.error('Project race watchdog: '+scenario);process.exit(2);},10000);
globalThis.fetch=()=>{throw Error('External network forbidden');};
try {
 const {fixture}=await load('.msb/bot/tests/helpers/menu-fixture.mjs');
 const {runAgentTurn}=await load('.msb/bot/src/agent/turn.mjs');
 const {loadState,saveState,updateState}=await load('.msb/bot/src/state.mjs');
 const {switchProviderSession,currentSessionProvider}=await load('overlay/bot/ext/provider-sessions.mjs');
 f=await fixture({after:fn=>cleanup.push(fn)},async request=>{const out=await runAgentTurn(request);results.push(out);return out;},{overlay:false});
 process.env.CLAUDE_CODE_OAUTH_TOKEN='fixture-race-auth';
 const root=path.join(path.dirname(f.workspace),'projects'),alpha=path.join(root,'alpha'),beta=path.join(root,'beta');
 for(const directory of [alpha,beta])await fs.mkdir(directory,{recursive:true});
 await fs.writeFile(path.join(f.workspace,'SOUL.md'),'fixture-owner-race-soul');
 await fs.writeFile(path.join(alpha,'.current-task.md'),'fixture-alpha-task');
 await fs.writeFile(path.join(beta,'.current-task.md'),'fixture-beta-task');
 report.alpha=alpha;report.beta=beta;report.realAlpha=await fs.realpath(alpha);report.realBeta=await fs.realpath(beta);
 const old='ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a10';
 const next='ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a20';
 const before={...(await loadState()).state,activeProject:'alpha',sessionEpoch:0,
  ccSessionId:scenario==='existing'?old:undefined,ccModel:'opus',ccEffort:'high',fixtureField:'keep-race'};
 delete before.parkedCcSessions;delete before.pendingCcSessionStarts;await saveState(before);
 const providerStoreBefore=await fs.readFile(f.storeFile,'utf8');
 savedSpawn=cp.spawn;
 cp.spawn=(command,args,options)=>{
  if(command!=='claude'||options.env.HOME!==f.home)throw Error('Unexpected child');
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
  const call={cwd:options.cwd,args,provider:options.env.MSB_TURN_PROVIDER,prompt:'',ready:false,closed:false};
  call.actualCwd=cp.execFileSync(process.execPath,['-e','process.stdout.write(process.cwd())'],{cwd:options.cwd,env:{HOME:f.home,PATH:path.dirname(process.execPath)},encoding:'utf8'});
  call.systemPrompt=args.includes('--append-system-prompt')?args[args.indexOf('--append-system-prompt')+1]:'';
  call.respond=id=>{
   if(call.closed)return;call.closed=true;
   child.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:id,provider_id:call.provider,model:'fixture-model'})+'\n');
   child.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:id,is_error:false,result:'fixture-project-answer'})+'\n');
   child.stdout.end();child.stderr.end();child.emit('close',0,null);
  };
  child.kill=()=>{if(!call.closed){call.closed=true;child.stdout.end();child.stderr.end();child.emit('close',null,'SIGINT');}return true;};
  child.stdin.on('data',chunk=>{call.prompt+=chunk;});child.stdin.on('finish',()=>{call.ready=true;});calls.push(call);return child;
 };
 syncBuiltinESMExports();
 let promptHeld=false;
 if(scenario==='preparing'){
  savedRead=fs.readFile.bind(fs);const gate=new Promise(r=>{releasePrompt=r;});let once=true;
  fs.readFile=async(file,...args)=>{
   if(once&&String(file)===path.join(f.workspace,'SOUL.md')){once=false;promptHeld=true;await gate;}
   return savedRead(file,...args);
  };
 }
 const switchTo=provider=>updateState(state=>{switchProviderSession(state,currentSessionProvider(state),provider);state.extAuthBypass=provider;return state;});
 if(scenario==='first-provider'){
  const start=prompt=>{const item={done:false};item.promise=runAgentTurn({prompt}).then(out=>{results.push(out);return out;}).finally(()=>{item.done=true;});direct.push(item);return item.promise;};
  const a=start('first-alpha');await until(()=>calls[0]?.ready,'first A child');
  await switchTo('claude');await f.callback('project:beta');
  report.afterProject=(await loadState()).state;
  const b=start('first-beta');await until(()=>calls[1]?.ready,'first B child');
  const bToken=(await loadState()).state.pendingCcSessionStarts?.claude;
  calls[0].respond(old);await a;
  report.afterOld=(await loadState()).state;
  report.newReservationSurvived=Boolean(bToken&&report.afterOld.pendingCcSessionStarts?.claude===bToken);
  calls[1].respond('fixture-claude-beta');await b;await switchTo('codex');
 }else{
  await f.message('old-alpha');
  if(scenario==='preparing')await until(()=>promptHeld,'prompt preparation barrier');else await until(()=>calls[0]?.ready,'old child');
  await f.callback('project:beta');report.afterProject=(await loadState()).state;releasePrompt();
  await until(()=>calls[0]?.ready,'captured old child');calls[0].respond(old);
  await until(()=>results.length===1,'old result');report.afterOld=(await loadState()).state;
  await f.message('new-beta');await until(()=>calls[1]?.ready,'new child');calls[1].respond(next);
  await until(()=>results.length===2,'new result');
 }
 report.state=(await loadState()).state;report.old=old;report.next=next;
 report.oldContextCleared=results[0]?.result?.context===null;
 report.providerStorePreserved=await fs.readFile(f.storeFile,'utf8')===providerStoreBefore;
 report.profilePreserved=report.state.fixtureField===before.fixtureField&&report.state.ccModel===before.ccModel&&report.state.ccEffort===before.ccEffort&&report.state.dailySpendLimit===before.dailySpendLimit;
 await f.bot.stop();
 console.log('PROJECT_RACE='+JSON.stringify(report));
}finally{
 releasePrompt();
 for(const call of calls)if(!call.closed)call.respond('fixture-cleanup-session');
 if(direct.length)await Promise.allSettled(direct.map(item=>item.promise));
 if(f)await f.bot.stop();
 if(savedRead)fs.readFile=savedRead;
 if(savedSpawn){cp.spawn=savedSpawn;syncBuiltinESMExports();}
 for(const fn of cleanup)await fn();clearTimeout(watchdog);
}
