import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {mock} from 'node:test';
// RED probe: synthetic Telegram selection, a delayed fake CLI status,
// temporary profile/marker, real scheduler and agent router, fake model.
// Run `node .msb/bot/tests/reference/probe-codex-provider-pause.mjs`.
// A successful reproduction is evidence of the defect, not a passing test.
if(!process.execArgv.includes('--experimental-test-module-mocks')) {
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--no-warnings',fileURLToPath(import.meta.url)],{
    env:{PATH:'/usr/bin:/bin',TMPDIR:process.env.TMPDIR||'/tmp'},stdio:'inherit',timeout:20000,
  });
  if(child.error)throw child.error;
  process.exit(child.status??1);
}
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const mod=relative=>pathToFileURL(path.join(repo,relative)).href;
const noop=()=>async()=>{};
mock.module(mod('.msb/bot/src/autonomy/openclaw-reminder-dispatch.mjs'),{namedExports:{createOpenClawReminderDispatcher:noop}});
mock.module(mod('.msb/bot/src/autonomy/reminder-dispatch.mjs'),{namedExports:{createReminderDispatcher:noop}});
mock.module(mod('.msb/bot/src/autonomy/legacy-dispatch.mjs'),{namedExports:{dispatchLegacyTimers:async()=>{},admitLegacyTimerRuns:async()=>[]}});
let fakeCodexBin;
const ensure=await import(mod('overlay/bot/ext/ensure-cli.mjs'));
mock.module(mod('overlay/bot/ext/ensure-cli.mjs'),{namedExports:{...ensure,ensureProviderCli:async provider=>{
  if(provider!=='codex'||!fakeCodexBin)throw Error('unexpected fixture CLI request');
  await fs.access(fakeCodexBin,fsConstants.X_OK);
  return {ok:true,bin:fakeCodexBin,skipped:true};
}}});
const observed=[];
mock.module(mod('.msb/bot/src/agent/claude.mjs'),{namedExports:{runClaudeTurn:async opts=>{
  observed.push({provider:opts.providerId,session:opts.sessionId});
  return {sessionId:opts.sessionId||'',providerId:opts.providerId,text:'fixture',isError:false,usage:{inputTokens:0,outputTokens:0}};
}}});
const engine=await import(mod('.msb/bot/src/engines/client.mjs'));
mock.module(mod('.msb/bot/src/engines/client.mjs'),{namedExports:{...engine,engineStatusSnapshot:async()=>null}});
const {fixture}=await import(mod('.msb/bot/tests/helpers/menu-fixture.mjs'));
const {startScheduler}=await import(mod('.msb/bot/src/autonomy/scheduler.mjs'));
const {runAgentTurn}=await import(mod('.msb/bot/src/agent/turn.mjs'));
const {saveState,loadState}=await import(mod('.msb/bot/src/state.mjs'));
const {addTask,listTasks}=await import(mod('.msb/bot/src/autonomy/store.mjs'));
const {setActive}=await import(mod('overlay/bot/ext/store.mjs'));
const cleanups=[];const t={after:fn=>cleanups.push(fn)};
let release,selection,scheduler,tick;
const waitGate=new Promise(resolve=>{release=resolve;});let entered;
const runEntered=new Promise(resolve=>{entered=resolve;});
async function until(fn,label){const end=Date.now()+6000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('timeout '+label);}
try {
 const f=await fixture(t,undefined,{overlay:true});
 process.env.CLAUDE_CODE_OAUTH_TOKEN='fixture';
 process.env.TASK_FIXTURE_DIR=f.home;
 const base=(await loadState()).state;
 const {extAuthBypass,...claude}=base;
 await saveState({...claude,engine:'cc',ccSessionId:'fixture-claude',parkedCcSessions:{codex:base.ccSessionId},authMode:'subscription',hasSubscriptionAuth:true});
 await setActive('claude');
 const bin=path.join(f.home,'.local/bin');await fs.mkdir(bin,{recursive:true});
 const program='#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then\n touch "$TASK_FIXTURE_DIR/status-wait"\n i=0; while [ ! -f "$TASK_FIXTURE_DIR/status-release" ] && [ "$i" -lt 300 ]; do sleep 0.02; i=$((i+1)); done\n [ -f "$TASK_FIXTURE_DIR/status-release" ] || exit 1\n echo "Logged in using ChatGPT"; exit 0\nfi\necho "fixture unexpected command" >&2; exit 3\n';
 fakeCodexBin=path.join(bin,'codex');await fs.writeFile(fakeCodexBin,program,{mode:0o700});
 await fs.access(fakeCodexBin,fsConstants.X_OK);
 const codexDir=path.join(f.home,'.codex');await fs.mkdir(codexDir,{recursive:true});
 await fs.writeFile(path.join(codexDir,'auth.json'),JSON.stringify({auth_mode:'chatgpt'}));
 await addTask({id:'fixture',prompt:'synthetic',everyHours:1,nextAt:Date.now()-1000});
 selection=f.callback('ext:conn:set:codex');
 await until(()=>fs.access(path.join(f.home,'status-wait')).then(()=>true,()=>false),'selection reached fake status');
 const initial=(await loadState()).state;assert.equal(initial.extAuthBypass,undefined);
 const marker=path.join(process.env.MSB_RUNTIME_ROOT,'engine','sleep.default');await fs.mkdir(path.dirname(marker),{recursive:true});await fs.writeFile(marker,'fixture');
 scheduler=startScheduler({log(){},runTurn:async args=>{entered();await waitGate;return runAgentTurn(args);}});
 tick=scheduler.tickNow();await runEntered;
 assert.equal((await loadState()).state.extAuthBypass,undefined);
 await fs.writeFile(path.join(f.home,'status-release'),'ok');await selection;selection=null;
 const selected=(await loadState()).state;assert.equal(selected.extAuthBypass,'codex');
 assert.equal(selected.ccSessionId,base.ccSessionId);assert.equal(await fs.readFile(marker,'utf8'),'fixture');
 release();await tick;tick=null;
 assert.equal(observed.length,1);assert.equal(observed[0].provider,'codex');
 assert.equal(await fs.readFile(marker,'utf8'),'fixture');assert.ok((await listTasks())[0].nextAt>Date.now());
 console.log('RED REPRODUCED: after an in-flight switch, the interval entered the fake Codex runner despite the preserved pause marker.');
 console.log('Only temporary files, fake Telegram, fake CLI status and a fake model runner were used.');
} finally {
 release();
 if(process.env.TASK_FIXTURE_DIR)await fs.writeFile(path.join(process.env.TASK_FIXTURE_DIR,'status-release'),'ok').catch(()=>{});
 if(selection)await selection.catch(()=>{});if(tick)await tick.catch(()=>{});if(scheduler)await scheduler.stop();
 for(const cleanup of cleanups.reverse())await cleanup();
}
