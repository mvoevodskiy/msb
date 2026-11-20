/**
 * RED diagnostic, not a passing correctness test: with a temporary profile and
 * fake Telegram/turn, demonstrate that /stop currently does not interrupt an
 * already started direct interval. Run `node tests/reference/probe-active-interval-stop.mjs`
 * from .msb/bot. The child enables module mocks and has a minimal environment.
 * Unrelated dispatchers are mocked before import; no real model or network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--no-warnings',fileURLToPath(import.meta.url)],{
    env:{PATH:process.env.PATH||'/usr/bin:/bin',TMPDIR:process.env.TMPDIR||'/tmp'},stdio:'inherit',timeout:10000,
  });
  if(child.error)throw child.error;
  process.exit(child.status??1);
}

const {mock}=await import('node:test');
const url=relative=>new URL(`../../src/${relative}`,import.meta.url).href;
const idle=()=>async()=>{};
mock.module(url('autonomy/openclaw-reminder-dispatch.mjs'),{namedExports:{createOpenClawReminderDispatcher:idle}});
mock.module(url('autonomy/reminder-dispatch.mjs'),{namedExports:{createReminderDispatcher:idle}});
mock.module(url('autonomy/legacy-dispatch.mjs'),{namedExports:{dispatchLegacyTimers:async()=>{},admitLegacyTimerRuns:async()=>[]}});
mock.module(url('agent/turn.mjs'),{namedExports:{runAgentTurn:async()=>{throw Error('real turn prohibited');},supportsCodexAttachments:()=>false}});
const {fixture}=await import('../helpers/menu-fixture.mjs');
const {startScheduler}=await import('../../src/autonomy/scheduler.mjs');
const {addTask,listTasks}=await import('../../src/autonomy/store.mjs');

const after=[];
const t={after:fn=>after.push(fn)};
let release, scheduler, tick;
const gate=new Promise(resolve=>{release=resolve;});
let started, captured;
const entered=new Promise(resolve=>{started=resolve;});
try {
  const f=await fixture(t,undefined,{overlay:false});
  await addTask({id:'fixture',prompt:'synthetic',nextAt:Date.now()-1000,everyHours:1});
  const before=await listTasks();
  scheduler=startScheduler({scheduledTurns:f.bot[Symbol.for('msb.scheduledTurns')],log(){},
    runTurn:async({signal})=>{captured=signal;started();await gate;return {ok:true,text:'fixture'};}});
  tick=scheduler.tickNow();
  await entered;
  await f.message('/stop');
  assert.equal(captured.aborted,false);
  assert.equal(f.messages.at(-1),'Нечего останавливать 🤷');
  release();await tick;tick=null;
  assert.ok((await listTasks())[0].nextAt>before[0].nextAt);
  console.log('RED REPRODUCED: /stop does not abort an already started direct interval; fake Telegram replies that there is nothing to stop.');
  console.log('Only a temporary profile, fake Telegram and fake turn were used. No live service was contacted.');
} finally {
  release();
  if(tick)await tick.catch(()=>{});
  if(scheduler)await scheduler.stop();
  for(const cleanup of after.reverse())await cleanup();
}
