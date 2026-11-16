/** Worker for autonomy-same-bot-claim tests. All turns and dispatchers are fake. */
import { mock } from 'node:test';
const url = relative => new URL(`../../src/${relative}`, import.meta.url).href;
const idle = () => async () => {};
mock.module(url('autonomy/openclaw-reminder-dispatch.mjs'), {namedExports:{createOpenClawReminderDispatcher:idle}});
mock.module(url('autonomy/reminder-dispatch.mjs'), {namedExports:{createReminderDispatcher:idle}});
mock.module(url('agent/turn.mjs'), {namedExports:{runAgentTurn:async()=>{throw Error('real turn prohibited');}}});
mock.module(url('autonomy/legacy-dispatch.mjs'), {namedExports:{dispatchLegacyTimers:async()=>{}}});
if(process.env.TASK_TEST_RELEASE_LOCK_FAILURE==='1') {
  const lockUrl = new URL('../../shared/file-lock.mjs', import.meta.url).href;
  const real = await import(lockUrl);
  mock.module(lockUrl, {namedExports:{...real,withFileLock:async(file,action)=>{
    const outcome = await real.withFileLock(file,action);
    if (String(file).endsWith('/tasks.json') && outcome === true) {
      process.send({event:'lock-release-failed'});
      throw Error('synthetic task lock release failure');
    }
    return outcome;
  }}});
}
const store=await import(url('autonomy/store.mjs'));
let releaseRead,readCount=0;
const readGate=new Promise(resolve=>{releaseRead=resolve;});
if(process.env.TASK_TEST_STORE_GATE==='1' || process.env.TASK_TEST_FINAL_LOCK_GATE==='1') {
  mock.module(url('autonomy/store.mjs'), {namedExports:{...store,listTasks:async(...args)=>{
    const rows=await store.listTasks(...args);
    if(process.env.TASK_TEST_STORE_GATE==='1' && ++readCount===3){process.send({event:'last-read'});await readGate;}
    return rows;
  },admitCurrentTask:(...args)=>{
    if(process.env.TASK_TEST_FINAL_LOCK_GATE==='1')process.send({event:'final-admission'});
    return store.admitCurrentTask(...args);
  }}});
}
const owner=await import(url('autonomy/owner-pause.mjs'));
let admit;
const admission=new Promise(resolve=>{admit=resolve;});
if(process.env.TASK_TEST_ADMISSION==='1') {
  let pauseCount=0;
  mock.module(url('autonomy/owner-pause.mjs'), {namedExports:{...owner,readAutonomyPause:async(...args)=>{
    if(++pauseCount===Number(process.env.TASK_TEST_ADMISSION_AT||1)){process.send({event:'admission'});await admission;}
    return owner.readAutonomyPause(...args);
  }}});
}
const {startScheduler}=await import(url('autonomy/scheduler.mjs'));
const {withAutonomyPauseLock,engageOwnerPauseLocked}=owner;
let release;
const gate=new Promise(resolve=>{release=resolve;});
const scheduledTurns=process.env.TASK_TEST_SCHEDULED==='1'?{stopEpoch:0,pending:false}:undefined;
const scheduler=startScheduler({log:message=>{if(String(message).includes('tick error'))process.send({event:'logged-error'});},
  adminId:42,scheduledTurns,api:{sendMessage:async()=>process.send({event:'delivery'})},
  runTurn:({signal,prompt})=>{
    process.send({event:'entered',prompt});
    if(process.env.TASK_TEST_TURN_FAILURE==='throw')throw Error('synthetic synchronous turn failure');
    if(process.env.TASK_TEST_TURN_FAILURE==='reject')return Promise.reject(Error('synthetic asynchronous turn failure'));
    if(process.env.TASK_TEST_TURN_FAILURE==='deferred')return Promise.resolve({ok:false,intervalDeferred:true});
    return (async()=>{
      if(process.env.TASK_TEST_DELAY_ABORT_EXIT==='1')await gate;
      else await Promise.race([gate,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
      if(signal.aborted){process.send({event:'aborted'});return {ok:false,error:'aborted'};}
      process.send({event:'left'});return {ok:true,text:'fixture'};
    })();
  }});
process.on('message',async message=>{
  if (message==='release') return release();
  if (message==='admit') return admit();
  if (message==='read-release') return releaseRead();
  if (message==='stop') {scheduledTurns.stopEpoch++;process.send({event:'stopped'});return;}
  if (message==='pending') {scheduledTurns.pending=true;process.send({event:'pending'});return;}
  if (message==='pause') {
    try {await withAutonomyPauseLock(()=>engageOwnerPauseLocked({now:Date.now()}));process.send({event:'paused'});}
    catch(error){process.send({event:'error',message:String(error)});}
    return;
  }
  if (message!=='start') return;
  try {await scheduler.tickNow();await scheduler.stop();process.send({event:'done'});}
  catch(error){process.send({event:'error',message:String(error)});}
});
process.send({event:'ready'});
