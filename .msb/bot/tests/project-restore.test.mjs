/** Old boot project behavior, excluding destructive overwrites; synthetic HOME. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './helpers/menu-fixture.mjs';
import {loadState,saveState} from '../src/state.mjs';
import {statePath} from '../src/paths.mjs';
import {prepareProjectSupport,restoreProjectState} from '../src/projects/restore.mjs';
const envFor=f=>({HOME:f.home,MSB_BOT_ID:'default',MSB_WORKSPACE_DIR:f.workspace});
const root=f=>path.join(path.dirname(f.workspace),'projects');

test('project boot: no selected project creates support but leaves the profile byte-exact',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env=envFor(f),before=await fs.readFile(statePath(env),'utf8');
 assert.deepEqual(await restoreProjectState(env),{restored:false,cleared:false});
 assert.equal(await fs.readlink(path.join(root(f),'CLAUDE.md')),path.join(f.workspace,'CLAUDE.md'));
 assert.equal(await fs.readFile(statePath(env),'utf8'),before);
});
test('project boot: a valid saved project keeps its session/model/auth and stored bytes',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env=envFor(f);await fs.mkdir(path.join(root(f),'alpha'),{recursive:true});
 await saveState({...((await loadState()).state),activeProject:'alpha',fixtureField:'keep'});
 const before=await fs.readFile(statePath(env),'utf8');assert.deepEqual(await restoreProjectState(env),{restored:true,cleared:false});
 assert.equal(await fs.readFile(statePath(env),'utf8'),before);
});
test('project boot: missing saved directory returns to base without resuming an old project conversation',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env=envFor(f),before={...((await loadState()).state),activeProject:'gone',sessionEpoch:3,lastCcUsage:{inputTokens:123},parkedCcSessions:{claude:'fixture-old'},pendingCcSessionStarts:{codex:'fixture-token'}};
 await saveState(before);assert.deepEqual(await restoreProjectState(env),{restored:false,cleared:true});const next=(await loadState()).state;
 for(const key of ['activeProject','ccSessionId','lastCcUsage','parkedCcSessions','pendingCcSessionStarts'])assert.equal(next[key],undefined);
 assert.equal(next.sessionEpoch,4);assert.equal(next.extAuthBypass,before.extAuthBypass);assert.equal(next.dailySpendLimit,before.dailySpendLimit);
});
test('project boot: permission errors preserve the selected project/session and omit private error details',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env=envFor(f);await fs.mkdir(path.join(root(f),'alpha'),{recursive:true});await saveState({...((await loadState()).state),activeProject:'alpha'});
 const before=await fs.readFile(statePath(env),'utf8'),stat=fs.stat.bind(fs),logs=[];
 t.mock.method(fs,'stat',async(file,...args)=>{if(String(file)===path.join(root(f),'alpha'))throw Object.assign(Error('fixture-private-detail'),{code:'EACCES'});return stat(file,...args);});
 assert.deepEqual(await restoreProjectState(env,{log:s=>logs.push(s)}),{restored:false,cleared:false,unavailable:true});assert.equal(await fs.readFile(statePath(env),'utf8'),before);
 assert.equal(logs.join('').includes('fixture-private-detail'),false);
});
for(const kind of ['file','link'])test('project boot: preserve an existing user '+kind+' at projects/CLAUDE.md',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env=envFor(f);await fs.mkdir(root(f));const link=path.join(root(f),'CLAUDE.md');
 if(kind==='file')await fs.writeFile(link,'fixture-custom-rules');else await fs.symlink('fixture-user-target',link);
 await prepareProjectSupport(env);
 assert.equal(kind==='file'?await fs.readFile(link,'utf8'):await fs.readlink(link),kind==='file'?'fixture-custom-rules':'fixture-user-target');
});


test('project boot: a late missing-directory check cannot clear a newer project and conversation',async t=>{
 const f=await fixture(t,undefined,{overlay:false}),env=envFor(f);
 await saveState({...((await loadState()).state),activeProject:'gone',sessionEpoch:3});
 let begin,release;const checking=new Promise(r=>{begin=r;}),gate=new Promise(r=>{release=r;});t.after(()=>release());
 const stat=fs.stat.bind(fs);
 t.mock.method(fs,'stat',async(file,...args)=>{
  if(String(file)===path.join(root(f),'gone')){begin();await gate;throw Object.assign(Error('fixture missing'),{code:'ENOENT'});}
  return stat(file,...args);
 });
 const restoring=restoreProjectState(env);await checking;
 const newer={...((await loadState()).state),activeProject:'beta',sessionEpoch:4,ccSessionId:'fixture-newer-project-session'};await saveState(newer);
 release();assert.deepEqual(await restoring,{restored:false,cleared:false});assert.deepEqual((await loadState()).state,newer);
});
