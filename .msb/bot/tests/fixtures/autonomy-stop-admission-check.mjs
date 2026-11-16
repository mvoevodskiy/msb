/**
 * Real Telegram /stop handler and interval admission over a temporary profile.
 * All network, model calls and unrelated dispatchers are fake. Run with
 * node --experimental-test-module-mocks --test this-file.
 */
import test, {mock} from 'node:test';
import assert from 'node:assert/strict';

const url = relative => new URL(`../../src/${relative}`, import.meta.url).href;
const idle = () => async () => {};
mock.module(url('autonomy/openclaw-reminder-dispatch.mjs'), {namedExports:{createOpenClawReminderDispatcher:idle}});
mock.module(url('autonomy/reminder-dispatch.mjs'), {namedExports:{createReminderDispatcher:idle}});
mock.module(url('autonomy/legacy-dispatch.mjs'), {namedExports:{dispatchLegacyTimers:async()=>{},admitLegacyTimerRuns:async()=>[]}});
mock.module(url('agent/turn.mjs'), {namedExports:{runAgentTurn:async()=>{throw Error('real turn prohibited');},supportsCodexAttachments:()=>false}});
const owner=await import(url('autonomy/owner-pause.mjs'));
let observed,admit;
const atAdmission=new Promise(resolve=>{observed=resolve;});
const resume=new Promise(resolve=>{admit=resolve;});
mock.module(url('autonomy/owner-pause.mjs'), {namedExports:{...owner,readAutonomyPause:async(...args)=>{
  observed();await resume;return owner.readAutonomyPause(...args);
}}});
const {fixture}=await import('../helpers/menu-fixture.mjs');
const {startScheduler}=await import('../../src/autonomy/scheduler.mjs');
const {addTask,listTasks}=await import('../../src/autonomy/store.mjs');

test('Telegram /stop during interval admission prevents the pending model turn', {timeout:10000}, async t=>{
  const f=await fixture(t,undefined,{overlay:false});
  await addTask({id:'fixture',prompt:'synthetic',nextAt:Date.now()-1000,everyHours:1});
  const before=await listTasks();let turns=0;
  const scheduledTurns=f.bot[Symbol.for('msb.scheduledTurns')];
  const scheduler=startScheduler({scheduledTurns,log(){},runTurn:async()=>{turns++;return {ok:true,text:'fixture'};}});
  t.after(async()=>{admit();await scheduler.stop();});
  const tick=scheduler.tickNow();
  await atAdmission;
  await f.message('/stop');
  admit();await tick;
  assert.equal(turns,0);
  assert.deepEqual(await listTasks(),before);
  assert.ok(f.messages.length>0);
});
