/**
 * RED diagnostic: an edit during the final pause check can still arrive after
 * the last task snapshot and before the fake model turn. This intentionally
 * expects the observed remaining race and is not a passing correctness test.
 * Run: node .msb/bot/tests/reference/probe-interval-stale-admission.mjs
 * Synthetic files, fake turn/Telegram, and mocked unrelated dispatchers only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addTask,listTasks,saveAllTasks } from '../../src/autonomy/store.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'interval-stale-red-'));
const runtime=path.join(root,'runtime'),id='same';
const env={PATH:process.env.PATH||'/usr/bin:/bin',MSB_RUNTIME_ROOT:runtime,MSB_BOT_ID:id,
  AUTONOMY_DIR:path.join(root,'autonomy'),MSB_SESSION_DIR:path.join(runtime,'bots',id,'sessions'),
  TASK_TEST_ADMISSION:'1',TASK_TEST_ADMISSION_AT:'2'};
const worker=fileURLToPath(new URL('../fixtures/autonomy-claim-worker.mjs',import.meta.url));
let child;
try {
  await addTask({id:'fixture',prompt:'synthetic',everyHours:1,nextAt:Date.now()-1000},env);
  child=fork(worker,[],{env,execArgv:['--experimental-test-module-mocks','--no-warnings'],stdio:['ignore','ignore','pipe','ipc']});
  const seen=[],waiting=[];let stderr='';
  child.stderr.on('data',x=>{stderr+=x;});
  child.on('message',message=>{
    const i=waiting.findIndex(w=>w.event===message.event);
    if(i>=0){const [entry]=waiting.splice(i,1);clearTimeout(entry.timeout);entry.resolve(message);}
    else seen.push(message);
  });
  const wait=event=>{
    const i=seen.findIndex(message=>message.event===event);
    if(i>=0)return Promise.resolve(seen.splice(i,1)[0]);
    return new Promise((resolve,reject)=>{
      const entry={event,resolve,timeout:null};
      entry.timeout=setTimeout(()=>{const at=waiting.indexOf(entry);if(at>=0)waiting.splice(at,1);reject(Error(`waiting for ${event}: ${stderr.slice(0,200)}`));},5000);
      waiting.push(entry);
    });
  };
  await wait('ready');child.send('start');await wait('admission');
  const changed=await listTasks(env);changed[0].prompt='owner-updated';changed[0].enabled=false;
  await saveAllTasks(changed,env);
  child.send('release');child.send('admit');await wait('done');
  assert.equal(seen.filter(event=>event.event==='entered').length,1);
  assert.equal(seen.filter(event=>event.event==='delivery').length,1);
  assert.deepEqual(await listTasks(env),changed);
  console.log('RED REPRODUCED: a task edited during the final pause check can still start; the later save preserves the edited row.');
} finally {
  if(child && child.exitCode===null && child.signalCode===null){
    await new Promise(resolve=>{child.once('exit',resolve);if(child.connected)child.disconnect();child.kill('SIGKILL');});
  }
  await fs.rm(root,{recursive:true,force:true});
}
