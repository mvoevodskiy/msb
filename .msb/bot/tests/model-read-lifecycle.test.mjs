/** Cold native metadata must not block readonly navigation; no provider/auth calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { saveState, loadState } from '../src/state.mjs';
const tasks=Symbol.for('msb.callbackTasks');
async function until(fn) { for(let i=0;i<500;i++){if(await fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('metadata barrier timed out'); }
async function cold(t) {
  const f=await fixture(t),entered=path.join(f.home,'metadata-entered'),release=path.join(f.home,'metadata-release');
  await fs.writeFile(f.storeFile,JSON.stringify({version:1,active:'claude'}));
  await saveState({engine:'cc',ccModel:'sonnet',ccSessionId:'claude-cold-fixture'});
  const script=`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(entered)},'1'); while(!fs.existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,5));process.stdout.write('2.1.300 (Claude Code)');`;
  await fs.writeFile(process.env.MSB_REAL_CLAUDE,script);
  return {f,entered,release};
}

test('cold Versions read releases polling and a later settings screen wins over its final render', async t => {
  const {f,entered,release}=await cold(t);let returned=false;
  const opening=f.callback('settings:model:ver',42,{waitForRender:false}).then(()=>{returned=true;});
  try {
    await until(()=>fs.access(entered).then(()=>true,()=>false));
    assert.equal(returned,true,'readonly handler must return before --version finishes');
    await f.callback('menu:settings');const latest=f.edits.at(-1);
    await fs.writeFile(release,'1');await opening;await Promise.allSettled([...(f.bot[tasks]||[])]);
    assert.equal(f.edits.at(-1),latest,'old version screen cannot replace newer navigation');
  } finally {await fs.writeFile(release,'1');await opening;}
});

test('shutdown cancels the view and drains its native metadata query before returning', async t => {
  const {f,entered,release}=await cold(t);let closed=false;
  const opening=f.callback('settings:model:ver',42,{waitForRender:false});
  let stop;
  try {
    await until(()=>fs.access(entered).then(()=>true,()=>false));
    const before=(await loadState()).state;
    stop=f.bot.stop().then(()=>{closed=true;});await new Promise(setImmediate);
    assert.equal(closed,false,'stop must drain the tracked metadata task');
    await fs.writeFile(release,'1');await opening;await stop;
    assert.deepEqual((await loadState()).state,before);assert.equal(f.edits.length,0);
  } finally {await fs.writeFile(release,'1');await opening;await stop;}
});
