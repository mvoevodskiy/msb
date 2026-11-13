/** Isolated synthetic summary protocol and guarded bootstrap completion. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCodexBootstrap } from '../src/agent/codex-bootstrap.mjs';
import { saveState, loadState, updateState } from '../src/state.mjs';
import { resetCliConversation } from '../src/sessions/selection.mjs';

const scope = '42:42:0';
const session = 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
const other = 'ext:codex:0299a213-81c0-7800-8aa1-bbab2a035a53';
const yes = JSON.stringify({version:1,save:true,user:['Имя: Анна'],memory:['Работает над исследованием']});
const no = JSON.stringify({version:1,save:false,user:[],memory:[]});
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'intro-integration-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const workspace = path.join(root,'workspace'), profile = path.join(root,'codex-profile');
  await fs.mkdir(workspace); await fs.mkdir(profile);
  const env = {HOME:root, MSB_WORKSPACE_DIR:workspace, MSB_RUNTIME_ROOT:path.join(root,'.msb'),
    MSB_BOT_ID:'default', MSB_RUNTIME_PROFILE:'msb', CODEX_HOME:profile};
  const state = {engine:'cc',extAuthBypass:'codex',sessionEpoch:2,...options};
  await saveState(state,env);
  return {root,workspace,profile,env};
}
function result(text, id = session) { return {text,providerId:'codex',sessionId:id,isError:false}; }
async function reserveAtLimit(f, extra = {}) {
  const cwd = await fs.realpath(f.workspace);
  await updateState(s => {s.codexBootstrap = {[scope]: {workspace:f.workspace, profileDir:f.profile,
    turns:8, sessionId:session, capturedEpoch:2, activationEpoch:2, cwd, ...extra}}; return s;}, f.env);
}
test('natural finish privately summarizes the same thread and retains it, keeping original reply', async t => {
  const f=await fixture(t), calls=[];
  const runner=async opts=>{calls.push(opts); if(opts.codexIntroSummary)return result(yes);
    await fs.writeFile(path.join(f.workspace,'SOUL.md'),'Owner identity'); return result('visible answer');};
  const out=await runCodexBootstrap({scope,prompt:'owner message',env:f.env,runner});
  assert.equal(calls.length,2); assert.equal(calls[1].sessionId,session);
  assert.equal(calls[1].cwd,f.workspace); assert.equal(calls[1].codexIntroSummary,true);
  assert.equal(calls[1].codexProfile.CODEX_HOME,f.profile);
  assert.match(calls[1].prompt,/строго вида/); assert.doesNotMatch(out.text,/version|memory/);
  assert.equal(out.text,'visible answer'); assert.equal(out.bootstrapComplete,true);
  const {state}=await loadState(f.env); assert.equal(state.ccSessionId,session);
  assert.equal(state.sessionHistory[0].firstPrompt,'Знакомство');
  assert.equal(state.codexServiceSetup.scope,scope);
  assert.match(await fs.readFile(path.join(f.workspace,'USER.md'),'utf8'),/Имя: Анна/);
  assert.match(await fs.readFile(path.join(f.workspace,'MEMORY.md'),'utf8'),/Работает над исследованием/);
});
test('limit signals handoff of the untouched ninth input after summary, without an intro invocation', async t => {
  const f=await fixture(t),calls=[]; await reserveAtLimit(f);
  const runner=async opts=>{calls.push(opts);return result(no);};
  const out=await runCodexBootstrap({scope,prompt:'ninth original',env:f.env,runner});
  assert.deepEqual(out,{ok:true,bootstrapHandoff:true,bootstrapComplete:true});
  assert.equal(calls.length,1); assert.equal(calls[0].codexIntroSummary,true);
  assert.equal(calls[0].sessionId,session); assert.ok(!calls[0].prompt.includes('ninth original'));
  assert.equal((await loadState(f.env)).state.ccSessionId,session);
  await assert.rejects(fs.stat(path.join(f.workspace,'USER.md')),{code:'ENOENT'});
});
test('invalid/secret summary fails closed with generic error and keeps retry checkpoint', async t => {
  const f=await fixture(t); await reserveAtLimit(f);
  await assert.rejects(runCodexBootstrap({scope,prompt:'ninth',env:f.env,
    runner:async()=>result('password=abc-private')}), e=>e.message==='Не удалось завершить знакомство. Попробуй ещё раз.');
  let state=(await loadState(f.env)).state; assert.equal(state.codexBootstrap[scope].finish,'fallback');
  assert.equal(state.ccSessionId,undefined);
  await assert.rejects(fs.stat(path.join(f.workspace,'.iia-bootstrapped')),{code:'ENOENT'});
  const out=await runCodexBootstrap({scope,prompt:'retry input',env:f.env,runner:async()=>result(no)});
  assert.equal(out.bootstrapHandoff,true); state=(await loadState(f.env)).state;
  assert.equal(state.ccSessionId,session);
});
test('clear while summary is in flight fences filesystem and automatic activation', async t => {
  const f=await fixture(t); await reserveAtLimit(f);
  let entered; const started=new Promise(r=>entered=r); let unblock; const wait=new Promise(r=>unblock=r);
  const running=runCodexBootstrap({scope,prompt:'ninth',env:f.env,runner:async()=>{entered();await wait;return result(yes);}});
  await started; await resetCliConversation(f.env,{bootstrapScope:scope}); unblock();
  const out=await running; assert.equal(out.ok,false); assert.match(out.text,/изменился/);
  const state=(await loadState(f.env)).state; assert.equal(state.ccSessionId,undefined);
  await assert.rejects(fs.stat(path.join(f.workspace,'USER.md')),{code:'ENOENT'});
});
test('abort while summary in flight never commits it', async t => {
  const f=await fixture(t);await reserveAtLimit(f);const controller=new AbortController();
  const out=await runCodexBootstrap({scope,prompt:'ninth',env:f.env,signal:controller.signal,
    runner:async()=>{controller.abort(); return result(yes);}});
  assert.equal(out.error,'aborted'); assert.equal((await loadState(f.env)).state.ccSessionId,undefined);
  await assert.rejects(fs.stat(path.join(f.workspace,'USER.md')),{code:'ENOENT'});
});
test('a different active session is not overwritten during completion', async t => {
  const f=await fixture(t);await reserveAtLimit(f);
  const out=await runCodexBootstrap({scope,prompt:'ninth',env:f.env,runner:async()=>{
    await updateState(s=>{s.ccSessionId=other;return s;},f.env);return result(no);}});
  assert.equal(out.bootstrapHandoff,true);
  const state=(await loadState(f.env)).state;assert.equal(state.ccSessionId,other);
  assert.equal(state.sessionHistory[0].id,session);
});
test('an introduction from the base workspace is not auto-activated in a different project cwd', async t => {
  const f=await fixture(t, {activeProject:'alpha'});
  const project=path.join(f.root,'projects','alpha'); await fs.mkdir(project,{recursive:true});
  await reserveAtLimit(f, {capturedProject:'alpha', cwd:await fs.realpath(project)});
  const out=await runCodexBootstrap({scope,prompt:'ninth',env:f.env,runner:async()=>result(no)});
  assert.equal(out.bootstrapHandoff,true);
  const state=(await loadState(f.env)).state;
  assert.equal(state.ccSessionId,undefined);
  assert.equal(state.sessionHistory[0].id,session);
});
test('failed publication is retried without rerunning the introduction or duplicating saved facts', async t => {
  const f=await fixture(t);await reserveAtLimit(f); let failed=false;
  const link=fs.link;
  t.mock.method(fs,'link',async (source,target)=>{
    if(!failed && target===path.join(f.workspace,'MEMORY.md')) {failed=true;throw Object.assign(new Error('io error'),{code:'EACCES'});}
    return link(source,target);
  });
  await assert.rejects(runCodexBootstrap({scope,prompt:'first',env:f.env,runner:async()=>result(yes)}),/Не удалось завершить/);
  assert.match(await fs.readFile(path.join(f.workspace,'USER.md'),'utf8'),/Имя: Анна/);
  assert.equal((await loadState(f.env)).state.codexBootstrap[scope].finish,'fallback');
  const out=await runCodexBootstrap({scope,prompt:'retry',env:f.env,runner:async()=>{
    assert.fail('A validated summary must not be regenerated after a partial publication');}});
  assert.equal(out.bootstrapHandoff,true);
  assert.equal((await fs.readFile(path.join(f.workspace,'USER.md'),'utf8')).match(/Имя: Анна/g).length,1);
  assert.match(await fs.readFile(path.join(f.workspace,'MEMORY.md'),'utf8'),/Работает над исследованием/);
});
test('a changed project during summary fences writes and handoff', async t => {
  const f=await fixture(t);await reserveAtLimit(f);
  const out=await runCodexBootstrap({scope,prompt:'ninth',env:f.env,runner:async()=>{
    await updateState(s=>{s.activeProject='other';return s;},f.env);return result(yes);}});
  assert.equal(out.ok,false);assert.match(out.text,/изменился/);
  assert.equal((await loadState(f.env)).state.ccSessionId,undefined);
  await assert.rejects(fs.stat(path.join(f.workspace,'USER.md')),{code:'ENOENT'});
});
test('newtask between introduction turns keeps history but does not reactivate the old conversation', async t => {
  const f=await fixture(t);await reserveAtLimit(f);
  await resetCliConversation(f.env);
  const out=await runCodexBootstrap({scope,prompt:'ninth',env:f.env,runner:async opts=>{
    assert.equal(opts.sessionId,session);return result(no);}});
  assert.equal(out.bootstrapHandoff,true);
  const state=(await loadState(f.env)).state;
  assert.equal(state.ccSessionId,undefined);
  assert.equal(state.sessionHistory[0].id,session);
});
test('newtask while summary runs fences activation until an explicit later retry', async t => {
  const f=await fixture(t);await reserveAtLimit(f);
  const out=await runCodexBootstrap({scope,prompt:'ninth',env:f.env,runner:async()=>{
    await resetCliConversation(f.env);return result(no);}});
  assert.equal(out.ok,false);assert.match(out.text,/изменился/);
  assert.equal((await loadState(f.env)).state.ccSessionId,undefined);
  const retry=await runCodexBootstrap({scope,prompt:'later',env:f.env,runner:async()=>result(no)});
  assert.equal(retry.bootstrapHandoff,true);
  const state=(await loadState(f.env)).state;
  assert.equal(state.ccSessionId,undefined);
  assert.equal(state.sessionHistory[0].id,session);
});
