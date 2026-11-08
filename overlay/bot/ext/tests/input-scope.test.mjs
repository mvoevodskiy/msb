import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setPendingAuth, getPendingAuth, clearPendingAuth } from '../auth.mjs';
import { setPendingLocalIp, getPendingLocalIp, clearPendingLocalIp } from '../local-ssh.mjs';
import { handleAuthMessage } from '../integration/text-input.mjs';

async function fixture(t) {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'msb-input-scope-')),previous={...process.env};
  Object.assign(process.env,{HOME:home,MSB_RUNTIME_ROOT:home,MSB_RUNTIME_PROFILE:'msb',MSB_BOT_ID:'default'});
  clearPendingAuth(42);clearPendingLocalIp(42);
  const calls=[],writes=[];let clock=1_000_000;
  t.mock.method(Date,'now',()=>clock);
  // A bad branch must fail before installer/native auth; even a regression cannot
  // write a secret or reach its subsequent CLI setup. The HOME is synthetic too.
  t.mock.method(fs,'writeFile',async(...args)=>{writes.push(String(args[0]));throw Error('Forbidden input-scope fixture write');});
  t.after(async()=>{clearPendingAuth(42);clearPendingLocalIp(42);for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,previous);await fs.rm(home,{recursive:true,force:true});});
  const bot={api:{sendMessage:async(chat,text)=>{calls.push({chat,text});return{message_id:999};},deleteMessage:async(chat,id)=>{calls.push({chat,deleted:id});}}};
  return{calls,writes,advance(ms){clock+=ms;},send:(chat,text)=>handleAuthMessage(bot,{from:{id:42},chat:{id:chat},message_id:11,text})};
}

test('input scope: provider input in chat A is not cancelled by an owner command in chat B',async t=>{
  const f=await fixture(t);setPendingAuth(42,'cursor',101);
  assert.equal(await f.send(202,'/status'),false);
  assert.equal(getPendingAuth(42)?.chatId,101);assert.deepEqual(f.calls,[]);assert.deepEqual(f.writes,[]);
});

test('input scope: local IP input in chat A is not cancelled by an owner command in chat B',async t=>{
  const f=await fixture(t);setPendingLocalIp(42,{chatId:101});
  assert.equal(await f.send(202,'/status'),false);
  assert.equal(getPendingLocalIp(42)?.chatId,101);assert.deepEqual(f.calls,[]);assert.deepEqual(f.writes,[]);
});

test('input scope: stale Codex secret prompt belongs only to its originating chat',async t=>{
  const f=await fixture(t);setPendingAuth(42,'codex',101);
  assert.equal(await f.send(202,'ordinary_task_from_another_chat'),false);
  assert.equal(getPendingAuth(42)?.chatId,101);assert.deepEqual(f.calls,[]);assert.deepEqual(f.writes,[]);
});

for(const type of ['auth','ip']) test(`input expiry: ${type} consumes late originating text instead of falling into the model`,async t=>{
  const f=await fixture(t);
  if(type==='auth')setPendingAuth(42,'cursor',101);else setPendingLocalIp(42,{chatId:101});
  f.advance(600_001);
  assert.equal(await f.send(101,type==='auth'?'fixture_late_key_'+ 'x'.repeat(60):'192.168.77.55'),true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].chat,101);assert.match(f.calls[0].text,/Время на ввод .* истекло/);
  assert.deepEqual(f.writes,[]);
});

for(const type of ['auth','ip']) test(`input expiry: another chat does not discard the expired ${type} notice for its owner`,async t=>{
  const f=await fixture(t);
  if(type==='auth')setPendingAuth(42,'cursor',101);else setPendingLocalIp(42,{chatId:101});
  f.advance(600_001);
  assert.equal(await f.send(202,'ordinary_task_in_another_chat'),false);assert.deepEqual(f.calls,[]);
  assert.equal(await f.send(101,type==='auth'?'fixture_late_key_'+ 'x'.repeat(60):'192.168.77.55'),true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].chat,101);assert.match(f.calls[0].text,/Время на ввод .* истекло/);
  assert.deepEqual(f.writes,[]);
});

test('input scope control: originating Codex guidance still consumes input without storing a key',async t=>{
  const f=await fixture(t);setPendingAuth(42,'codex',101);
  assert.equal(await f.send(101,'fixture_should_never_be_stored'),true);
  assert.match(f.calls[0].text,/Для Codex секрет в чат не нужен/);assert.equal(getPendingAuth(42),null);assert.deepEqual(f.writes,[]);
});
