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
import { tryWithFileLock, withFileLock } from '../shared/file-lock.mjs';
import { saveState } from '../src/state.mjs';

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


async function setupSingle(t,{admission=false,scheduled=false,twoTasks=false,storeGate=false,admissionAt=1}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'autonomy-claim-single-'));
  const runtime=path.join(root,'runtime'),autonomy=path.join(root,'autonomy'),id='same';
  const env={PATH:process.env.PATH||'/usr/bin:/bin',MSB_RUNTIME_ROOT:runtime,MSB_BOT_ID:id,
    AUTONOMY_DIR:autonomy,MSB_SESSION_DIR:path.join(runtime,'bots',id,'sessions'),
    ...(admission?{TASK_TEST_ADMISSION:'1',TASK_TEST_ADMISSION_AT:String(admissionAt)}:{}),
    ...(scheduled?{TASK_TEST_SCHEDULED:'1'}:{}),...(storeGate?{TASK_TEST_STORE_GATE:'1'}:{})};
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


for(const change of ['edit','delete']) test(`a task ${change} during the first admission check prevents the stale turn`, {timeout:10000}, async t=>{
  const f=await setupSingle(t,{admission:true}),w=f.launch();
  await w.wait('ready');w.send('start');await w.wait('admission');
  const tasks=await listTasks(f.env);
  if(change==='edit'){tasks[0].prompt='owner-updated';tasks[0].enabled=false;}
  await saveAllTasks(change==='delete'?[]:tasks,f.env);
  w.send('release');w.send('admit');await w.wait('done');
  assert.deepEqual(await listTasks(f.env),change==='delete'?[]:tasks);
  assert.equal(w.events.filter(event=>event.event==='entered').length,0);
  assert.equal(w.events.filter(event=>event.event==='delivery').length,0);
});

for(const pause of ['owner','codex']) test(`a ${pause} pause set during the repeated task read prevents the model turn`, {timeout:10000}, async t=>{
  const f=await setupSingle(t,{storeGate:true}),w=f.launch();
  if(pause==='codex')await saveState({engine:'cc',extAuthBypass:'codex'},f.env);
  const before=await listTasks(f.env);
  await w.wait('ready');w.send('start');await w.wait('last-read');
  const marker=pause==='owner'?path.join(path.dirname(f.env.MSB_SESSION_DIR),'autonomy','STOP')
    :path.join(f.env.MSB_RUNTIME_ROOT,'engine','sleep.same');
  await fs.mkdir(path.dirname(marker),{recursive:true});
  await fs.writeFile(marker,'synthetic');
  w.send('release');w.send('read-release');await w.wait('done');
  assert.deepEqual(await listTasks(f.env),before);
  assert.equal(await fs.readFile(marker,'utf8'),'synthetic');
  assert.equal(w.events.filter(event=>event.event==='entered').length,0);
});

for(const command of ['stop','pending']) test(`${command} during the second admission check prevents the model turn`, {timeout:10000}, async t=>{
  const f=await setupSingle(t,{admission:true,admissionAt:2,scheduled:true}),w=f.launch();
  const before=await listTasks(f.env);
  await w.wait('ready');w.send('start');await w.wait('admission');
  w.send(command);await w.wait(command==='stop'?'stopped':'pending');
  w.send('release');w.send('admit');await w.wait('done');
  assert.deepEqual(await listTasks(f.env),before);
  assert.equal(w.events.filter(event=>event.event==='entered').length,0);
});

for (const change of ['edit', 'delete']) test(`a task ${change} during the final pause check prevents admission`, { timeout: 10000 }, async t => {
  const f = await setupSingle(t, { admission: true, admissionAt: 2 }), w = f.launch();
  await w.wait('ready'); w.send('start'); await w.wait('admission');
  const tasks = await listTasks(f.env);
  if (change === 'edit') { tasks[0].prompt = 'owner-updated'; tasks[0].enabled = false; }
  const changed = change === 'delete' ? [] : tasks;
  await saveAllTasks(changed, f.env);
  w.send('release'); w.send('admit'); await w.wait('done');
  assert.equal(w.events.filter(event => event.event === 'entered').length, 0);
  assert.equal(w.events.filter(event => event.event === 'delivery').length, 0);
  assert.deepEqual(await listTasks(f.env), changed);
});

for (const failure of ['throw', 'reject', 'deferred']) test(`a ${failure} at admission leaves the task due without a notification`, { timeout: 10000 }, async t => {
  const f = await setupSingle(t), before = await listTasks(f.env);
  const first = f.launch({ TASK_TEST_TURN_FAILURE: failure });
  await first.wait('ready'); first.send('start'); await first.wait('entered');
  if (failure !== 'deferred') await first.wait('logged-error');
  await first.wait('done');
  assert.deepEqual(await listTasks(f.env), before);
  assert.equal(first.events.filter(event => event.event === 'delivery').length, 0);
  const next = f.launch(); await next.wait('ready'); next.send('start'); await next.wait('entered');
  next.send('release'); await next.wait('done');
  assert.ok((await listTasks(f.env))[0].nextAt > Date.now());
});

test('a simulated lock cleanup failure aborts and drains its started turn before retry', { timeout: 10000 }, async t => {
  const f = await setupSingle(t), before = await listTasks(f.env);
  const first = f.launch({ TASK_TEST_RELEASE_LOCK_FAILURE: '1' });
  await first.wait('ready'); first.send('start'); await first.wait('entered');
  await first.wait('lock-release-failed'); await first.wait('aborted'); await first.wait('logged-error'); await first.wait('done');
  assert.deepEqual(await listTasks(f.env), before);
  assert.equal(first.events.filter(event => event.event === 'delivery').length, 0);
  const next = f.launch(); await next.wait('ready'); next.send('start'); await next.wait('entered');
  next.send('release'); await next.wait('done');
  assert.ok((await listTasks(f.env))[0].nextAt > Date.now());
});

for (const operation of ['stop', 'pending', 'pause']) test(`${operation} while waiting for the task lock prevents admission`, { timeout: 10000 }, async t => {
  const f = await setupSingle(t, { scheduled: true }), before = await listTasks(f.env);
  const locked = {}; locked.ready = new Promise(resolve => { locked.mark = resolve; });
  const release = {}; release.ready = new Promise(resolve => { release.mark = resolve; });
  const file = path.resolve(f.env.AUTONOMY_DIR, 'tasks.json');
  const holder = withFileLock(file, async () => { locked.mark(); await release.ready; });
  await locked.ready;
  const worker = f.launch({ TASK_TEST_FINAL_LOCK_GATE: '1' });
  try {
    await worker.wait('ready'); worker.send('start'); await worker.wait('final-admission');
    worker.send(operation); await worker.wait(operation === 'pause' ? 'paused' : operation === 'stop' ? 'stopped' : 'pending');
  } finally { release.mark(); await holder; }
  await worker.wait('done');
  assert.equal(worker.events.filter(event => event.event === 'entered').length, 0);
  assert.equal(worker.events.filter(event => event.event === 'delivery').length, 0);
  assert.deepEqual(await listTasks(f.env), before);
});

for (const pause of ['owner', 'fleet']) test(`an external ${pause} pause while waiting for the task lock prevents admission`, { timeout: 10000 }, async t => {
  const f = await setupSingle(t), before = await listTasks(f.env);
  const locked = {}; locked.ready = new Promise(resolve => { locked.mark = resolve; });
  const release = {}; release.ready = new Promise(resolve => { release.mark = resolve; });
  const holder = withFileLock(path.resolve(f.env.AUTONOMY_DIR, 'tasks.json'), async () => { locked.mark(); await release.ready; });
  await locked.ready;
  const worker = f.launch({ TASK_TEST_FINAL_LOCK_GATE: '1' });
  try {
    await worker.wait('ready'); worker.send('start'); await worker.wait('final-admission');
    const root = path.dirname(f.env.MSB_SESSION_DIR);
    await fs.mkdir(path.join(root, 'autonomy'), { recursive: true });
    if (pause === 'owner') await fs.writeFile(path.join(root, 'autonomy', 'STOP'), 'synthetic');
    else await fs.writeFile(path.join(root, 'remote-config.json'), JSON.stringify({ autonomyGlobalStop: true }));
  } finally { release.mark(); await holder; }
  worker.send('release'); await worker.wait('done');
  assert.equal(worker.events.filter(event => event.event === 'entered').length, 0);
  assert.equal(worker.events.filter(event => event.event === 'delivery').length, 0);
  assert.deepEqual(await listTasks(f.env), before);
});

test('a delayed abort after simulated lock failure keeps the interval claim but not the task lock', { timeout: 10000 }, async t => {
  const f = await setupSingle(t), before = await listTasks(f.env);
  const first = f.launch({ TASK_TEST_RELEASE_LOCK_FAILURE: '1', TASK_TEST_DELAY_ABORT_EXIT: '1' });
  await first.wait('ready'); first.send('start'); await first.wait('entered'); await first.wait('lock-release-failed');
  const contender = f.launch(); await contender.wait('ready'); contender.send('start'); await contender.wait('done');
  assert.equal(contender.events.filter(event => event.event === 'entered').length, 0);
  await saveAllTasks(before, f.env);
  first.send('release'); await first.wait('aborted'); await first.wait('logged-error'); await first.wait('done');
  assert.deepEqual(await listTasks(f.env), before);
  const next = f.launch(); await next.wait('ready'); next.send('start'); await next.wait('entered');
  next.send('release'); await next.wait('done');
  assert.ok((await listTasks(f.env))[0].nextAt > Date.now());
});

test('an unreadable fleet pause during task admission fails closed', { timeout: 10000 }, async t => {
  const f = await setupSingle(t), before = await listTasks(f.env);
  const locked = {}; locked.ready = new Promise(resolve => { locked.mark = resolve; });
  const release = {}; release.ready = new Promise(resolve => { release.mark = resolve; });
  const holder = withFileLock(path.resolve(f.env.AUTONOMY_DIR, 'tasks.json'), async () => { locked.mark(); await release.ready; });
  await locked.ready;
  const worker = f.launch({ TASK_TEST_FINAL_LOCK_GATE: '1' });
  try {
    await worker.wait('ready'); worker.send('start'); await worker.wait('final-admission');
    const root = path.dirname(f.env.MSB_SESSION_DIR);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'remote-config.json'), '{broken-json');
  } finally { release.mark(); await holder; }
  await worker.wait('logged-error'); await worker.wait('done');
  assert.equal(worker.events.filter(event => event.event === 'entered').length, 0);
  assert.deepEqual(await listTasks(f.env), before);
});

test('an edit after admission keeps its due time and the next tick uses the edited prompt', { timeout: 10000 }, async t => {
  const f = await setupSingle(t), first = f.launch();
  await first.wait('ready'); first.send('start');
  const old = await first.wait('entered'); assert.match(old.prompt, /synthetic/);
  const changed = await listTasks(f.env); changed[0].prompt = 'owner-updated-only';
  await saveAllTasks(changed, f.env);
  first.send('release'); await first.wait('done');
  assert.deepEqual(await listTasks(f.env), changed, 'The prior result cannot overwrite the edit.');
  assert.ok(changed[0].nextAt <= Date.now(), 'The unchanged due time can cause a later rerun.');
  const second = f.launch(); await second.wait('ready'); second.send('start');
  const current = await second.wait('entered'); assert.match(current.prompt, /owner-updated-only/);
  second.send('release'); await second.wait('done');
  assert.ok((await listTasks(f.env))[0].nextAt > Date.now());
});
