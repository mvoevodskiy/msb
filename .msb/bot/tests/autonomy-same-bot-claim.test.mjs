/**
 * Regression for [RED probe](./reference/probe-shared-interval-race.mjs):
 * separate processes, synthetic task/turn and fake Telegram; unrelated
 * dispatchers (including OpenClaw) mocked before the scheduler is imported.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addTask, listTasks, saveAllTasks } from '../src/autonomy/store.mjs';
import { tryWithFileLock } from '../shared/file-lock.mjs';

const worker=fileURLToPath(new URL('./fixtures/autonomy-claim-worker.mjs',import.meta.url));
async function race(t,ids,{alias=false,twoTasks=false,separateAutonomy=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'autonomy-claim-'));
  const runtime=path.join(root,'runtime'),autonomy=path.join(root,'autonomy');
  const alternate=path.join(root,'runtime-link');
  if(alias){await fs.mkdir(runtime,{recursive:true});await fs.symlink(runtime,alternate);}
  const parentEnv={MSB_RUNTIME_ROOT:runtime,MSB_BOT_ID:ids[0],AUTONOMY_DIR:autonomy};
  const secondAutonomy=separateAutonomy?path.join(root,'autonomy-second'):autonomy;
  await addTask({id:'fixture',prompt:'synthetic',everyHours:1,nextAt:Date.now()-1000},parentEnv);
  if(twoTasks)await addTask({id:'second',prompt:'synthetic-2',everyHours:1,nextAt:Date.now()-1000},parentEnv);
  if(separateAutonomy)await addTask({id:'separate',prompt:'synthetic-3',everyHours:1,nextAt:Date.now()-1000},{...parentEnv,AUTONOMY_DIR:secondAutonomy});
  const children=[],deliveries=[]; let ready=0,entered=0,active=0,maxActive=0,done=0,released=false,deadline;
  const completed=new Promise((resolve,reject)=>{
    deadline=setTimeout(()=>reject(Error(`timeout ready=${ready} entered=${entered} done=${done}`)),8000);
    for(const [index,id] of ids.entries()){
      const selectedRuntime=alias && index===1?alternate:runtime;
      const env={PATH:process.env.PATH||'/usr/bin:/bin',MSB_RUNTIME_ROOT:selectedRuntime,MSB_BOT_ID:id,
        AUTONOMY_DIR:separateAutonomy && index===1?secondAutonomy:autonomy,MSB_SESSION_DIR:path.join(selectedRuntime,'bots',id,'sessions')};
      const child=fork(worker,[],{env,execArgv:['--experimental-test-module-mocks','--no-warnings'],stdio:['ignore','ignore','pipe','ipc']});
      children.push(child);let stderr='';child.stderr.on('data',x=>{stderr+=x;});
      child.on('error',reject);
      child.on('exit',code=>{if(code && done<ids.length) reject(Error(`worker exited ${code}: ${stderr.slice(0,400)}`));});
      child.on('message',message=>{
        if(message.event==='error')return reject(Error(message.message));
        if(message.event==='ready' && ++ready===ids.length)children.forEach(c=>c.send('start'));
        if(message.event==='entered'){entered++;active++;maxActive=Math.max(maxActive,active);}
        if(message.event==='left')active--;
        if(message.event==='delivery')deliveries.push(id);
        if(message.event==='done')done++;
        // RED allows both to enter; fixed same-bot race has one enter and one
        // finish without waiting. In both cases release before asserting.
        if(!released && (entered>=2 || (entered>=1 && done>=1))){released=true;children.forEach(c=>{if(c.connected)c.send('release');});}
        if(done===ids.length){clearTimeout(deadline);resolve();}
      });
    }
  });
  try {
    await completed;
    return {entered,maxActive,deliveries,tasks:await listTasks(parentEnv),
      separateTasks:separateAutonomy?await listTasks({...parentEnv,AUTONOMY_DIR:secondAutonomy}):[]};
  } finally {
    clearTimeout(deadline);
    await Promise.all(children.map(child=>new Promise(resolve=>{
      if(child.exitCode!==null||child.signalCode!==null)return resolve();
      const timeout=setTimeout(()=>child.kill('SIGKILL'),1000);timeout.unref();
      child.once('exit',()=>{clearTimeout(timeout);resolve();});
      if(child.connected)child.disconnect();child.kill('SIGTERM');
    })));
    await fs.rm(root,{recursive:true,force:true});
  }
}

test('two scheduler processes for one bot start one due interval occurrence', {timeout:12000}, async t=>{
  const result=await race(t,['same','same']);
  assert.equal(result.entered,1);
  assert.equal(result.deliveries.length,1);
  assert.equal(result.tasks.length,1);
  assert.ok(result.tasks[0].nextAt>Date.now());
});

test('different due tasks of one bot do not run concurrently in the shared session', {timeout:12000}, async t=>{
  const result=await race(t,['same','same'],{twoTasks:true});
  assert.equal(result.entered,2);
  assert.equal(result.maxActive,1);
  assert.equal(result.deliveries.length,2);
  assert.ok(result.tasks.every(task=>task.nextAt>Date.now()));
});

test('one bot cannot run two intervals simultaneously from different task directories', {timeout:12000}, async t=>{
  const result=await race(t,['same','same'],{separateAutonomy:true});
  assert.equal(result.entered,1);
  assert.equal(result.maxActive,1);
  assert.equal(result.deliveries.length,1);
  const all=[...result.tasks,...result.separateTasks];
  assert.equal(all.filter(task=>task.nextAt>Date.now()).length,1);
  assert.equal(all.filter(task=>task.nextAt<=Date.now()).length,1);
});

test('runtime symlink aliases of the same bot share the claim', {timeout:12000}, async t=>{
  const result=await race(t,['same','same'],{alias:true});
  assert.equal(result.entered,1);
  assert.equal(result.deliveries.length,1);
});

test('different bots keep their existing shared-task behavior pending an ownership decision', {timeout:12000}, async t=>{
  const result=await race(t,['first','second']);
  assert.equal(result.entered,2);
  assert.deepEqual(result.deliveries.sort(),['first','second']);
});


async function setupSingle(t,{admission=false,scheduled=false,twoTasks=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'autonomy-claim-single-'));
  const runtime=path.join(root,'runtime'),autonomy=path.join(root,'autonomy'),id='same';
  const env={PATH:process.env.PATH||'/usr/bin:/bin',MSB_RUNTIME_ROOT:runtime,MSB_BOT_ID:id,
    AUTONOMY_DIR:autonomy,MSB_SESSION_DIR:path.join(runtime,'bots',id,'sessions'),
    ...(admission?{TASK_TEST_ADMISSION:'1'}:{}),...(scheduled?{TASK_TEST_SCHEDULED:'1'}:{})};
  const children=[];
  t.after(async()=>{
    await Promise.all(children.map(child=>new Promise(resolve=>{
      if(child.exitCode!==null||child.signalCode!==null)return resolve();
      child.once('exit',resolve);if(child.connected)child.disconnect();child.kill('SIGKILL');
    })));
    await fs.rm(root,{recursive:true,force:true});
  });
  await addTask({id:'fixture',prompt:'synthetic',everyHours:1,nextAt:Date.now()-1000},env);
  if(twoTasks)await addTask({id:'second',prompt:'synthetic-2',everyHours:1,nextAt:Date.now()-1000},env);
  function launch(overrides={}){
    const child=fork(worker,[],{env:{...env,...overrides},execArgv:['--experimental-test-module-mocks','--no-warnings'],stdio:['ignore','ignore','pipe','ipc']});
    children.push(child);const seen=[],waiting=[];let stderr='';
    child.stderr.on('data',x=>{stderr+=x;});
    child.on('message',message=>{
      const index=waiting.findIndex(w=>w.event===message.event);
      if(index>=0){const [entry]=waiting.splice(index,1);clearTimeout(entry.timeout);entry.resolve(message);}
      else seen.push(message);
    });
    function wait(event){
      const index=seen.findIndex(message=>message.event===event);
      if(index>=0)return Promise.resolve(seen.splice(index,1)[0]);
      return new Promise((resolve,reject)=>{
        const entry={event,resolve,reject,timeout:null};
        entry.timeout=setTimeout(()=>{const at=waiting.indexOf(entry);if(at>=0)waiting.splice(at,1);reject(Error(`waiting for ${event}: ${stderr.slice(0,200)}`));},5000);
        waiting.push(entry);
      });
    }
    return {child,wait,events:seen,send:message=>child.send(message)};
  }
  return {root,env,launch};
}

for(const change of ['edit','delete']) test(`the task store stays writable during a run and preserves ${change}`, {timeout:10000}, async t=>{
  const f=await setupSingle(t),w=f.launch();
  await w.wait('ready');w.send('start');await w.wait('entered');
  const tasks=await listTasks(f.env);
  if(change==='edit'){tasks[0].enabled=false;tasks[0].prompt='owner-edited';}
  await saveAllTasks(change==='delete'?[]:tasks,f.env);
  w.send('release');await w.wait('done');
  assert.deepEqual(await listTasks(f.env),change==='delete'?[]:tasks);
});

test('process death releases its claim for a later retry', {timeout:10000}, async t=>{
  const f=await setupSingle(t),first=f.launch();
  await first.wait('ready');first.send('start');await first.wait('entered');
  const exited=new Promise(resolve=>first.child.once('exit',resolve));
  first.child.kill('SIGKILL');await exited;
  const second=f.launch();await second.wait('ready');second.send('start');await second.wait('entered');
  second.send('release');await second.wait('done');
  assert.ok((await listTasks(f.env))[0].nextAt>Date.now());
});

test('owner pause interrupts the local run and releases its claim without advancing the task', {timeout:10000}, async t=>{
  const f=await setupSingle(t),first=f.launch();
  const before=await listTasks(f.env);
  await first.wait('ready');first.send('start');await first.wait('entered');
  first.send('pause');await first.wait('aborted');await first.wait('paused');await first.wait('done');
  assert.deepEqual(await listTasks(f.env),before);
  await fs.rm(path.join(path.dirname(f.env.MSB_SESSION_DIR),'autonomy','STOP'));
  const next=f.launch();await next.wait('ready');next.send('start');await next.wait('entered');
  next.send('release');await next.wait('done');
  assert.ok((await listTasks(f.env))[0].nextAt>Date.now());
});

test('a busy claim returns immediately and a throwing holder releases it', async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'autonomy-lock-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'claim');let release,entered;
  const held=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  const first=tryWithFileLock(file,async()=>{entered();await held;});
  await started;
  assert.equal(await tryWithFileLock(file,async()=>{throw Error('must not run');}),false);
  release();assert.equal(await first,true);
  await assert.rejects(tryWithFileLock(file,async()=>{throw Error('fixture');}),/fixture/);
  let ran=false;assert.equal(await tryWithFileLock(file,async()=>{ran=true;}),true);assert.equal(ran,true);
});


test('a stop during admission prevents an interval turn from starting', {timeout:10000}, async t=>{
  const f=await setupSingle(t,{admission:true,scheduled:true}),w=f.launch();
  const before=await listTasks(f.env);
  await w.wait('ready');w.send('start');await w.wait('admission');
  w.send('stop');await w.wait('stopped');w.send('release');w.send('admit');
  await w.wait('done');
  assert.deepEqual(await listTasks(f.env),before);
});


test('a queued scheduled turn arriving during admission keeps the interval due', {timeout:10000}, async t=>{
  const f=await setupSingle(t,{admission:true,scheduled:true}),w=f.launch();
  const before=await listTasks(f.env);
  await w.wait('ready');w.send('start');await w.wait('admission');
  w.send('pending');await w.wait('pending');w.send('release');w.send('admit');
  await w.wait('done');
  assert.deepEqual(await listTasks(f.env),before);
});

test('stop during one running interval prevents the next due task in that tick', {timeout:10000}, async t=>{
  const f=await setupSingle(t,{scheduled:true,twoTasks:true}),w=f.launch();
  const before=await listTasks(f.env);
  await w.wait('ready');w.send('start');await w.wait('entered');
  w.send('stop');await w.wait('stopped');w.send('release');await w.wait('done');
  const after=await listTasks(f.env);
  assert.ok(after[0].nextAt>Date.now());
  assert.deepEqual(after[1],before[1]);
  assert.equal(w.events.filter(event=>event.event==='entered').length,0);
});


test('a skipped interval in another directory runs on a later tick after claim release', {timeout:10000}, async t=>{
  const f=await setupSingle(t),other=path.join(f.root,'other-autonomy');
  const otherEnv={...f.env,AUTONOMY_DIR:other};
  await addTask({id:'other',prompt:'synthetic',everyHours:1,nextAt:Date.now()-1000},otherEnv);
  const first=f.launch(),contender=f.launch({AUTONOMY_DIR:other});
  await Promise.all([first.wait('ready'),contender.wait('ready')]);
  first.send('start');await first.wait('entered');
  contender.send('start');await contender.wait('done');
  assert.ok((await listTasks(otherEnv))[0].nextAt<=Date.now());
  first.send('release');await first.wait('done');
  const next=f.launch({AUTONOMY_DIR:other});
  await next.wait('ready');next.send('start');await next.wait('entered');
  next.send('release');await next.wait('done');
  assert.ok((await listTasks(otherEnv))[0].nextAt>Date.now());
});
