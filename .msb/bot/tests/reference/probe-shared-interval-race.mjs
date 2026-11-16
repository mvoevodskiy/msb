/**
 * Synthetic shared-interval regression probe using the real scheduler/store.
 * Run from iia root with `node .msb/bot/tests/reference/probe-shared-interval-race.mjs`.
 * The original RED reproduction is retained in git commit cc621f7. This
 * version expects one same-bot start and retains the different-bot control.
 * Worker mocks unrelated dispatchers *before* importing scheduler; their real
 * implementations are not called. No CLI, Telegram, network or owner data.
 * Evidence: scheduler.mjs tick/runTask and store.mjs saveTaskResult; no exact old
 * tasks.json analogue is claimed (old actions use a different storage path).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const moduleUrl = relative => pathToFileURL(path.join(REPO, '.msb/bot/src', relative)).href;

async function worker() {
  const { mock } = await import('node:test');
  const idle = () => async () => {};
  mock.module(moduleUrl('autonomy/openclaw-reminder-dispatch.mjs'), {namedExports:{createOpenClawReminderDispatcher:idle}});
  mock.module(moduleUrl('autonomy/reminder-dispatch.mjs'), {namedExports:{createReminderDispatcher:idle}});
  mock.module(moduleUrl('agent/turn.mjs'), {namedExports:{runAgentTurn:async () => { throw Error('real turn not allowed'); }}});
  const {startScheduler} = await import(moduleUrl('autonomy/scheduler.mjs'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const api = {sendMessage:async target => { process.send({event:'delivery',target}); }};
  const scheduler = startScheduler({api,adminId:Number(process.env.TASK_FAKE_OWNER),log(){},
    runTurn:async () => {process.send({event:'entered'});await gate;return {ok:true,text:'synthetic result'};}});
  process.on('message', async message => {
    if (message === 'release') return release();
    if (message !== 'go') return;
    try { await scheduler.tickNow(); await scheduler.stop(); process.send({event:'done'}); }
    catch (error) { process.send({event:'error',error:String(error)}); }
  });
  process.send({event:'ready'});
}

async function scenario(root, names, isolated, expectedEntered) {
  const {addTask,listTasks} = await import(moduleUrl('autonomy/store.mjs'));
  const runtime=path.join(root,'runtime');
  const dirs = names.map((_,index) => path.join(runtime, isolated ? `autonomy-${index}` : 'autonomy'));
  const envFor = (name,index) => ({MSB_RUNTIME_ROOT:runtime,MSB_BOT_ID:name,AUTONOMY_DIR:dirs[index]});
  await addTask({id:'synthetic-due',prompt:'fixture only',everyHours:1,nextAt:Date.now()-1000},envFor(names[0],0));
  const children=[]; let ready=0, entered=0, done=0, released=false; const deliveries=[];
  let deadline;
  const outcome = new Promise((resolve,reject)=>{
    deadline=setTimeout(()=>reject(Error(`timeout: ready=${ready}, entered=${entered}, done=${done}`)),8000);
    names.forEach((name,index)=>{
      const childEnv={PATH:process.env.PATH || '/usr/bin:/bin',TASK_FAKE_OWNER:String(name === names[0] ? 101 : 102),
        MSB_RUNTIME_ROOT:runtime,MSB_BOT_ID:name,AUTONOMY_DIR:dirs[index],
        MSB_SESSION_DIR:path.join(runtime,'bots',name,'sessions')};
      const child=fork(fileURLToPath(import.meta.url),['--worker'],{env:childEnv,
        execArgv:['--experimental-test-module-mocks','--no-warnings'],stdio:['ignore','ignore','pipe','ipc']});
      children.push(child); let stderr='';
      child.stderr.on('data',chunk=>{stderr+=String(chunk)});
      child.on('error',reject);
      child.on('exit',code=>{if(code && done<names.length)reject(Error(`worker exit ${code}: ${stderr.slice(0,400)}`));});
      child.on('message',message=>{
        if(message.event==='error') return reject(Error(message.error));
        if(message.event==='ready' && ++ready===names.length) children.forEach(c=>c.send('go'));
        if(message.event==='entered') entered++;
        if(message.event==='delivery') deliveries.push(message.target);
        if(message.event==='done') done++;
        // A same-bot contender must finish without entering before release;
        // a cross-bot control is released once both turns have entered.
        if(!released && (entered>=2 || (entered>=1 && done>=1))){
          released=true;children.forEach(c=>{if(c.connected)c.send('release');});
        }
        if(done===names.length){clearTimeout(deadline);resolve();}
      });
    });
  });
  try {
    await outcome;
    const tasks=await listTasks(envFor(names[0],0));
    const runs=(await fs.readFile(path.join(dirs[0],'runs.jsonl'),'utf8')).trim().split('\n');
    assert.equal(entered,expectedEntered);
    assert.equal(deliveries.length,expectedEntered);
    assert.equal(runs.length,expectedEntered);
    assert.equal(tasks.length,1);
    assert.ok(tasks[0].nextAt>Date.now());
    return {entered,deliveries:deliveries.sort((a,b)=>a-b),saved:tasks.length};
  } finally {
    clearTimeout(deadline);
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      force.unref();
      child.once('exit', () => { clearTimeout(force); resolve(); });
      if (child.connected) child.disconnect();
      child.kill('SIGTERM');
    })));
  }
}

async function main() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jarvis-interval-race-'));
  try {
    const sameBot=await scenario(path.join(root,'same-bot'),['same','same'],false,1);
    const twoBots=await scenario(path.join(root,'two-bots'),['first','second'],false,2);
    const isolated=await scenario(path.join(root,'isolated'),['first','second'],true,1);
    assert.deepEqual(sameBot.deliveries,[101]);
    assert.deepEqual(twoBots.deliveries,[101,102]);
    assert.deepEqual(isolated.deliveries,[101]);
    console.log('PASS: one due interval task starts once for two processes of the same bot.');
    console.log('BOUNDARY: two different bots sharing a task directory still start it twice pending an ownership decision.');
    console.log('CONTROL: a second bot with a separate task directory did not execute the first bot\'s fixture task.');
    console.log('Only synthetic files, fake runTurn and fake Telegram were used; unrelated dispatchers were mocked before scheduler import.');
  } finally {await fs.rm(root,{recursive:true,force:true});}
}

if(process.argv.includes('--worker')) await worker(); else await main();
