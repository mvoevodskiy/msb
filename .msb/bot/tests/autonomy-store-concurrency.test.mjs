import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addTask, listTasks, saveAllTasks } from '../src/autonomy/store.mjs';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'msb-task-transactions-'));
 const before={...process.env};Object.assign(process.env,{HOME:root,MSB_RUNTIME_ROOT:root,AUTONOMY_DIR:path.join(root,'autonomy'),MSB_SESSION_DIR:path.join(root,'sessions')});
 const release=[],pending=[];
 t.after(async()=>{release.forEach(g=>g.resolve());await Promise.allSettled(pending);for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,before);await fs.rm(root,{recursive:true,force:true});});
 return{root,release,pending};
}
async function heldRun(t) {
 const f=await fixture(t),entered=gate(),held=gate();f.release.push(held);
 await addTask({id:'A',prompt:'synthetic-A',nextAt:Date.now()-1000,everyHours:1});
 let turns=0;
 const scheduler=startScheduler({log(){},runTurn:async()=>{turns++;entered.resolve();await held.promise;return{ok:true,text:'synthetic result'};}});
 t.after(()=>scheduler.stop());const tick=scheduler.tickNow();f.pending.push(tick);await entered.promise;
 return{...f,held,tick,get turns(){return turns;}};
}

test('autonomy persistence: a task added during another run survives its completion',async t=>{
 const f=await heldRun(t);
 await addTask({id:'B',prompt:'synthetic-B',nextAt:Date.now()+3600000});
 f.held.resolve();await f.tick;
 const tasks=await listTasks();assert.deepEqual(tasks.map(t=>t.id),['A','B']);
 assert.ok(tasks[0].nextAt>Date.now());assert.equal(f.turns,1,'New tasks are picked up on a later tick.');
});

test('autonomy persistence: concurrent task additions retain every task without tmp-file collisions',async t=>{
 await fixture(t);
 const results=await Promise.allSettled(Array.from({length:12},(_,i)=>addTask({id:`T${i}`,prompt:`synthetic-${i}`})));
 assert.ok(results.every(r=>r.status==='fulfilled'), 'All independent task additions must finish.');
 assert.deepEqual((await listTasks()).map(t=>t.id).sort(),Array.from({length:12},(_,i)=>`T${i}`).sort());
});

for(const change of ['edit','delete']) test(`autonomy persistence: a ${change} during a run is never overwritten by a stale result`,async t=>{
 const f=await heldRun(t);
 const tasks=await listTasks();
 if(change==='edit'){tasks[0].prompt='new-owner-prompt';tasks[0].enabled=false;tasks[0].nextAt=123456789;}
 await saveAllTasks(change==='delete'?[]:tasks);
 f.held.resolve();await f.tick;
 const after=await listTasks();
 if(change==='delete') assert.deepEqual(after,[],'Do not resurrect a removed task.');
 else assert.deepEqual(after,tasks,'Do not replace newer task configuration or scheduling fields.');
});

test('autonomy persistence: a later failed task does not lose the completed earlier task checkpoint',async t=>{
 await fixture(t);
 for(const id of ['A','B'])await addTask({id,prompt:`synthetic-${id}`,nextAt:Date.now()-1000,everyHours:1});
 let calls=0;
 const scheduler=startScheduler({log(){},runTurn:async()=>{if(++calls===2)throw Error('fixture runner failure');return{ok:true,text:'done'};}});
 t.after(()=>scheduler.stop());await scheduler.tickNow();
 const tasks=await listTasks();assert.ok(tasks[0].nextAt>Date.now(),'The already completed run must stay committed even if a later run throws.');
 assert.equal(calls,2);
});


test('autonomy persistence: independent processes retain additions in the same task file', {timeout:15000}, async t=>{
 const f=await fixture(t),children=[],ready=[],closed=[];
 f.release.push({resolve(){for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');}});
 const worker=fileURLToPath(new URL('./fixtures/autonomy-concurrent.mjs',import.meta.url));
 for(let i=0;i<3;i++){
  const child=spawn(process.execPath,[worker,`P${i}`],{env:{PATH:process.env.PATH,HOME:f.root,MSB_RUNTIME_ROOT:f.root,AUTONOMY_DIR:path.join(f.root,'autonomy'),TMPDIR:f.root},stdio:['pipe','pipe','pipe']});
  children.push(child);let stderr='';child.stderr.on('data',c=>{stderr+=c;});
  ready.push(new Promise((resolve,reject)=>{child.stdout.on('data',data=>{if(String(data).includes('READY'))resolve();});child.on('error',reject);child.on('close',code=>{if(code!==0)reject(Error(`Writer startup: ${stderr}`));});}));
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(`Writer exit ${code}: ${stderr}`)));});
  closed.push(done);f.pending.push(done);
 }
 await Promise.all(ready);children.forEach(c=>c.stdin.end('go\n'));await Promise.all(closed);
 const ids=(await listTasks()).map(t=>t.id).sort();
 assert.deepEqual(ids,Array.from({length:3},(_,p)=>Array.from({length:4},(_,i)=>`P${p}-${i}`)).flat().sort());
});
