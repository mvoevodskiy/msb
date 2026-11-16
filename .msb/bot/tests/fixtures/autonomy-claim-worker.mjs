/** Worker for autonomy-same-bot-claim tests. All turns and dispatchers are fake. */
import { mock } from 'node:test';
const url = relative => new URL(`../../src/${relative}`, import.meta.url).href;
const idle = () => async () => {};
mock.module(url('autonomy/openclaw-reminder-dispatch.mjs'), {namedExports:{createOpenClawReminderDispatcher:idle}});
mock.module(url('autonomy/reminder-dispatch.mjs'), {namedExports:{createReminderDispatcher:idle}});
mock.module(url('agent/turn.mjs'), {namedExports:{runAgentTurn:async()=>{throw Error('real turn prohibited');}}});
mock.module(url('autonomy/legacy-dispatch.mjs'), {namedExports:{dispatchLegacyTimers:async()=>{}}});
const owner=await import(url('autonomy/owner-pause.mjs'));
let admit;
const admission=new Promise(resolve=>{admit=resolve;});
if(process.env.TASK_TEST_ADMISSION==='1') {
  mock.module(url('autonomy/owner-pause.mjs'), {namedExports:{...owner,readAutonomyPause:async(...args)=>{
    process.send({event:'admission'});await admission;return owner.readAutonomyPause(...args);
  }}});
}
const {startScheduler}=await import(url('autonomy/scheduler.mjs'));
const {withAutonomyPauseLock,engageOwnerPauseLocked}=owner;
let release;
const gate=new Promise(resolve=>{release=resolve;});
const scheduledTurns=process.env.TASK_TEST_SCHEDULED==='1'?{stopEpoch:0,pending:false}:undefined;
const scheduler=startScheduler({log(){},adminId:42,scheduledTurns,api:{sendMessage:async()=>process.send({event:'delivery'})},
  runTurn:async({signal})=>{process.send({event:'entered'});
    await Promise.race([gate,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
    if(signal.aborted){process.send({event:'aborted'});return {ok:false,error:'aborted'};}
    process.send({event:'left'});return {ok:true,text:'fixture'};}});
process.on('message',async message=>{
  if (message==='release') return release();
  if (message==='admit') return admit();
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
