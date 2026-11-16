/**
 * Real provider selection and interval routing with fake Telegram, CLI status
 * and model, using a temporary profile. Run through interval-provider-pause.test.
 */
import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const mod=relative=>pathToFileURL(path.join(root,relative)).href;
const idle=()=>async()=>{};
mock.module(mod('.msb/bot/src/autonomy/openclaw-reminder-dispatch.mjs'),{namedExports:{createOpenClawReminderDispatcher:idle}});
mock.module(mod('.msb/bot/src/autonomy/reminder-dispatch.mjs'),{namedExports:{createReminderDispatcher:idle}});
mock.module(mod('.msb/bot/src/autonomy/legacy-dispatch.mjs'),{namedExports:{dispatchLegacyTimers:async()=>{},admitLegacyTimerRuns:async()=>[]}});
let fakeCodexBin;
const ensure=await import(mod('overlay/bot/ext/ensure-cli.mjs'));
mock.module(mod('overlay/bot/ext/ensure-cli.mjs'),{namedExports:{...ensure,ensureProviderCli:async provider=>{
  if(provider!=='codex'||!fakeCodexBin)throw Error('unexpected fixture CLI request');
  await fs.access(fakeCodexBin,fsConstants.X_OK);
  return {ok:true,bin:fakeCodexBin,skipped:true};
}}});
const spawned=[];
mock.module(mod('.msb/bot/src/agent/claude.mjs'),{namedExports:{runClaudeTurn:async opts=>{
  spawned.push({provider:opts.providerId,session:opts.sessionId});
  return {sessionId:opts.sessionId||'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53',providerId:opts.providerId,
    text:'fixture',isError:false,usage:{inputTokens:0,outputTokens:0}};
}}});
const engine=await import(mod('.msb/bot/src/engines/client.mjs'));
mock.module(mod('.msb/bot/src/engines/client.mjs'),{namedExports:{...engine,engineStatusSnapshot:async()=>null}});
const {fixture}=await import(mod('.msb/bot/tests/helpers/menu-fixture.mjs'));
const {startScheduler}=await import(mod('.msb/bot/src/autonomy/scheduler.mjs'));
const {runAgentTurn}=await import(mod('.msb/bot/src/agent/turn.mjs'));
const {saveState,loadState,updateState,NO_STATE_WRITE}=await import(mod('.msb/bot/src/state.mjs'));
const {statePath}=await import(mod('.msb/bot/src/paths.mjs'));
const {withFileLock}=await import(mod('.msb/bot/shared/file-lock.mjs'));
const {addTask,listTasks}=await import(mod('.msb/bot/src/autonomy/store.mjs'));
const {setActive}=await import(mod('overlay/bot/ext/store.mjs'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+6000;while(Date.now()<end){if(await fn())return;await delay(10);}throw Error('timeout '+label);}

async function fakeStatus(f) {
  process.env.TASK_FIXTURE_DIR=f.home;
  const bin=path.join(f.home,'.local/bin');await fs.mkdir(bin,{recursive:true});
  const program='#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then\n touch "$TASK_FIXTURE_DIR/status-wait"\n i=0; while [ ! -f "$TASK_FIXTURE_DIR/status-release" ] && [ "$i" -lt 300 ]; do sleep 0.02; i=$((i+1)); done\n [ -f "$TASK_FIXTURE_DIR/status-release" ] || exit 1\n echo "Logged in using ChatGPT"; exit 0\nfi\necho "unexpected fixture command" >&2; exit 3\n';
  fakeCodexBin=path.join(bin,'codex');await fs.writeFile(fakeCodexBin,program,{mode:0o700});
  await fs.access(fakeCodexBin,fsConstants.X_OK);
  const dir=path.join(f.home,'.codex');await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'auth.json'),JSON.stringify({auth_mode:'chatgpt'}));
}

test('a switched Codex pause defers the interval and wake runs the same task once', {timeout:15000}, async t=>{
  spawned.length=0;
  const f=await fixture(t,undefined,{overlay:true});
  process.env.CLAUDE_CODE_OAUTH_TOKEN='fixture';
  const base=(await loadState()).state;
  const {extAuthBypass,...claude}=base;
  await saveState({...claude,engine:'cc',ccSessionId:'fixture-claude',parkedCcSessions:{codex:base.ccSessionId},
    authMode:'subscription',hasSubscriptionAuth:true});
  await setActive('claude');await fakeStatus(f);
  await addTask({id:'fixture',prompt:'synthetic',everyHours:1,nextAt:Date.now()-1000});
  const before=await listTasks(),notifications=[];
  let selection,scheduler,tick,release;
  const gate=new Promise(resolve=>{release=resolve;});let entered;
  const ready=new Promise(resolve=>{entered=resolve;});let first=true;
  try {
    selection=f.callback('ext:conn:set:codex');
    await until(()=>fs.access(path.join(f.home,'status-wait')).then(()=>true,()=>false),'selection CLI status');
    assert.equal((await loadState()).state.extAuthBypass,undefined);
    const marker=path.join(process.env.MSB_RUNTIME_ROOT,'engine','sleep.default');
    await fs.mkdir(path.dirname(marker),{recursive:true});await fs.writeFile(marker,'fixture');
    scheduler=startScheduler({log(){},adminId:42,api:{sendMessage:async(...args)=>{notifications.push(args);}},
      runTurn:async args=>{if(first){first=false;entered();await gate;}return runAgentTurn(args);}});
    tick=scheduler.tickNow();await ready;
    await fs.writeFile(path.join(f.home,'status-release'),'ok');await selection;selection=null;
    const selected=(await loadState()).state;
    assert.equal(selected.extAuthBypass,'codex');
    assert.equal(selected.ccSessionId,base.ccSessionId);
    assert.equal(selected.parkedCcSessions.claude,'fixture-claude');
    const selectedBytes=await fs.readFile(statePath(),'utf8');
    release();await tick;tick=null;
    assert.equal(spawned.length,0);
    assert.deepEqual(await listTasks(),before);
    assert.equal(notifications.length,0);
    assert.equal(await fs.readFile(marker,'utf8'),'fixture');
    assert.equal(await fs.readFile(statePath(),'utf8'),selectedBytes);
    await assert.rejects(fs.stat(path.join(process.env.MSB_RUNTIME_ROOT,'autonomy','runs.jsonl')),{code:'ENOENT'});
    await f.callback('eng:wake');
    await assert.rejects(fs.stat(marker),{code:'ENOENT'});
    await scheduler.tickNow();
    assert.equal(spawned.length,1);
    assert.equal(spawned[0].provider,'codex');
    assert.equal(spawned[0].session,base.ccSessionId);
    assert.equal(notifications.length,1);
    assert.ok((await listTasks())[0].nextAt>Date.now());
  } finally {
    release();await fs.writeFile(path.join(f.home,'status-release'),'ok').catch(()=>{});
    if(selection)await selection.catch(()=>{});if(tick)await tick.catch(()=>{});if(scheduler)await scheduler.stop();
  }
});


async function markerAt(env=process.env) {
  const file=path.join(env.MSB_RUNTIME_ROOT,'engine',`sleep.${env.MSB_BOT_ID||'default'}`);
  await fs.mkdir(path.dirname(file),{recursive:true});
  return file;
}
function gate(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

test('captured pause uses the passed bot profile without reserving a first session', async t=>{
  spawned.length=0;
  const f=await fixture(t,undefined,{overlay:false});
  const env={...process.env,MSB_RUNTIME_ROOT:path.join(f.home,'other-profile'),MSB_BOT_ID:'other'};
  const state={engine:'cc',extAuthBypass:'codex',authMode:'subscription',hasSubscriptionAuth:true,
    sessionEpoch:7,parkedCcSessions:{claude:'fixture-claude'}};
  await saveState(state,env);
  const marker=await markerAt(env);await fs.writeFile(marker,'fixture');
  const before=await fs.readFile(statePath(env),'utf8');
  const out=await runAgentTurn({prompt:'synthetic',autonomy:true,intervalShouldDefer:()=>false,env});
  assert.equal(out.intervalDeferred,true);assert.equal(spawned.length,0);
  assert.equal(await fs.readFile(statePath(env),'utf8'),before);
  assert.equal(await fs.readFile(marker,'utf8'),'fixture');
  await fs.unlink(marker);
  const otherMarker=await markerAt();await fs.writeFile(otherMarker,'other-bot');
  const after=await runAgentTurn({prompt:'synthetic',autonomy:true,intervalShouldDefer:()=>false,env});
  assert.equal(after.ok,true);assert.equal(spawned.length,1);assert.equal(spawned[0].provider,'codex');
  assert.equal(await fs.readFile(otherMarker,'utf8'),'other-bot');
  const saved=(await loadState(env)).state;
  assert.equal(saved.parkedCcSessions.claude,'fixture-claude');
  assert.equal(saved.pendingCcSessionStarts,undefined);
});

test('Claude interval remains runnable while the Codex marker exists', async t=>{
  spawned.length=0;
  await fixture(t,undefined,{overlay:false});
  await saveState({engine:'cc',ccSessionId:'fixture-claude',authMode:'subscription',hasSubscriptionAuth:true});
  const marker=await markerAt();await fs.writeFile(marker,'fixture');
  const original=fs.lstat;let markerReads=0;
  fs.lstat=async(file,...args)=>{if(String(file)===marker)markerReads++;return original(file,...args);};
  try {
    const out=await runAgentTurn({prompt:'synthetic',autonomy:true,intervalShouldDefer:()=>false});
    assert.equal(out.ok,true);assert.equal(spawned.length,1);assert.equal(spawned[0].provider,'claude');
    assert.equal(markerReads,0);assert.equal(await fs.readFile(marker,'utf8'),'fixture');
  } finally {fs.lstat=original;}
});

test('a direct non-interval turn retains its existing routing', async t=>{
  spawned.length=0;
  await fixture(t,undefined,{overlay:false});
  const marker=await markerAt();await fs.writeFile(marker,'fixture');
  const out=await runAgentTurn({prompt:'synthetic',autonomy:false,intervalShouldDefer:()=>true});
  assert.equal(out.ok,true);assert.equal(spawned.length,1);assert.equal(spawned[0].provider,'codex');
  assert.equal(await fs.readFile(marker,'utf8'),'fixture');
});

for(const mode of ['stop','abort']) test(`${mode} while the captured marker is being checked does not reserve a session`, async t=>{
  spawned.length=0;
  await fixture(t,undefined,{overlay:false});
  await saveState({engine:'cc',extAuthBypass:'codex',authMode:'subscription',hasSubscriptionAuth:true});
  const before=await fs.readFile(statePath(),'utf8'),marker=await markerAt();
  const reached=gate(),held=gate(),original=fs.lstat;let waiting=false,stopped=false;
  fs.lstat=async (file,...args)=>{if(String(file)===marker&&!waiting){waiting=true;reached.resolve();await held.promise;}return original(file,...args);};
  const controller=new AbortController();
  try {
    const running=runAgentTurn({prompt:'synthetic',autonomy:true,intervalShouldDefer:()=>stopped,signal:controller.signal});
    await reached.promise;
    if(mode==='stop')stopped=true;else controller.abort();
    held.resolve();const out=await running;
    if(mode==='stop')assert.equal(out.intervalDeferred,true);else assert.equal(out.error,'aborted');
    assert.equal(spawned.length,0);assert.equal(await fs.readFile(statePath(),'utf8'),before);
  } finally {held.resolve();fs.lstat=original;}
});

test('an unreadable captured marker defers without changing state', async t=>{
  spawned.length=0;
  await fixture(t,undefined,{overlay:false});
  const before=await fs.readFile(statePath(),'utf8'),marker=await markerAt();
  const original=fs.lstat;
  fs.lstat=async(file,...args)=>{if(String(file)===marker)throw Object.assign(Error('fixture denied'),{code:'EACCES'});return original(file,...args);};
  try {
    const out=await runAgentTurn({prompt:'synthetic',autonomy:true,intervalShouldDefer:()=>false});
    assert.equal(out.intervalDeferred,true);assert.equal(spawned.length,0);
    assert.equal(await fs.readFile(statePath(),'utf8'),before);
  } finally {fs.lstat=original;}
});

test('a busy marker and concurrent Claude selection finish without a lock cycle', {timeout:10000}, async t=>{
  spawned.length=0;
  const f=await fixture(t,undefined,{overlay:true});process.env.CLAUDE_CODE_OAUTH_TOKEN='fixture';
  const before=(await loadState()).state,marker=await markerAt();await fs.writeFile(marker,'fixture');
  const held=gate(),locked=gate(),reached=gate(),original=fs.lstat;let observed=false;
  const holder=withFileLock(marker,async()=>{locked.resolve();await held.promise;});
  await locked.promise;
  fs.lstat=async(file,...args)=>{const result=await original(file,...args);if(String(file)===marker&&!observed){observed=true;reached.resolve();}return result;};
  try {
    const turn=runAgentTurn({prompt:'synthetic',autonomy:true,intervalShouldDefer:()=>false});
    await reached.promise;
    const selection=f.callback('settings:engine:set:cc');
    held.resolve();await holder;
    const [out]=await Promise.all([turn,selection]);
    assert.equal(out.intervalDeferred,true);assert.equal(spawned.length,0);
    const state=(await loadState()).state;
    assert.equal(state.extAuthBypass,undefined);
    assert.equal(state.parkedCcSessions.codex,before.ccSessionId);
    await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  } finally {held.resolve();fs.lstat=original;await holder.catch(()=>{});}
});


test('a paused interval preserves an existing first-session reservation from another turn', async t=>{
  spawned.length=0;
  await fixture(t,undefined,{overlay:false});
  await saveState({engine:'cc',extAuthBypass:'codex',authMode:'subscription',hasSubscriptionAuth:true,
    pendingCcSessionStarts:{codex:'other-fixture-reservation'}});
  const marker=await markerAt();await fs.writeFile(marker,'fixture');
  const before=await fs.readFile(statePath(),'utf8');
  const out=await runAgentTurn({prompt:'synthetic',autonomy:true,intervalShouldDefer:()=>false});
  assert.equal(out.intervalDeferred,true);assert.equal(spawned.length,0);
  assert.equal(await fs.readFile(statePath(),'utf8'),before);
});

test('stop while waiting for the state queue defers before touching the first session', async t=>{
  spawned.length=0;
  await fixture(t,undefined,{overlay:false});
  await saveState({engine:'cc',extAuthBypass:'codex',authMode:'subscription',hasSubscriptionAuth:true});
  const before=await fs.readFile(statePath(),'utf8');
  const locked=gate(),held=gate();let stopped=false;
  const holder=updateState(async()=>{locked.resolve();await held.promise;return NO_STATE_WRITE;});
  await locked.promise;
  try {
    const running=runAgentTurn({prompt:'synthetic',autonomy:true,intervalShouldDefer:()=>stopped});
    stopped=true;held.resolve();await holder;
    const out=await running;
    assert.equal(out.intervalDeferred,true);assert.equal(spawned.length,0);
    assert.equal(await fs.readFile(statePath(),'utf8'),before);
  } finally {held.resolve();await holder.catch(()=>{});}
});

test('defer immediately after reserving a first session releases only its own reservation', async t=>{
  spawned.length=0;
  await fixture(t,undefined,{overlay:false});
  const state={engine:'cc',extAuthBypass:'codex',authMode:'subscription',hasSubscriptionAuth:true,
    pendingCcSessionStarts:{claude:'other-fixture-reservation'}};
  await saveState(state);
  let checks=0;
  const out=await runAgentTurn({prompt:'synthetic',autonomy:true,intervalShouldDefer:()=>++checks>=3});
  assert.equal(out.intervalDeferred,true);assert.equal(spawned.length,0);
  assert.deepEqual((await loadState()).state,state);
});

test('Codex pause set while the task lock is busy still defers the captured provider', {timeout:10000}, async t=>{
  spawned.length=0;
  const f=await fixture(t,undefined,{overlay:false});
  await addTask({id:'fixture',prompt:'synthetic',everyHours:1,nextAt:Date.now()-1000});
  const before=await listTasks(),marker=await markerAt();
  const {autonomyDir}=await import(mod('.msb/bot/src/paths.mjs'));
  const file=path.resolve(autonomyDir(),'tasks.json'),locked=gate(),held=gate();
  const holder=withFileLock(file,async()=>{locked.resolve();await held.promise;});
  await locked.promise;
  const scheduler=startScheduler({log(){},adminId:42,api:{sendMessage:async()=>{}},runTurn:runAgentTurn});
  let tick;
  try {
    tick=scheduler.tickNow();
    await until(()=>{
      const queued=globalThis[Symbol.for('msb.providerStoreUpdates')]?.get(file);
      return Boolean(queued && queued!==holder);
    },'final task admission queued behind the held lock');
    await fs.writeFile(marker,'fixture');
    held.resolve();await holder;await tick;tick=null;
    assert.equal(spawned.length,0);
    assert.deepEqual(await listTasks(),before);
    assert.equal(await fs.readFile(marker,'utf8'),'fixture');
    await f.callback('eng:wake');
    await scheduler.tickNow();
    assert.equal(spawned.length,1);
    assert.equal(spawned[0].provider,'codex');
  } finally {held.resolve();await holder.catch(()=>{});if(tick)await tick.catch(()=>{});await scheduler.stop();}
});
