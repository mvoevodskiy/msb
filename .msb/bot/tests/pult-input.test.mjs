import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { readEnvMap } from '../src/env/store.mjs';
import { setPendingAuth, getPendingAuth, clearPendingAuth } from '../../../overlay/bot/ext/auth.mjs';
import { setPendingLocalIp, getPendingLocalIp, clearPendingLocalIp } from '../../../overlay/bot/ext/local-ssh.mjs';

async function pultFixture(t) {
  const turns = [], f = await fixture(t, async request => { turns.push(request.prompt); return { ok: true, text: 'fixture response' }; });
  // Production IPC still writes into the synthetic HOME. Supply only its response;
  // no host /run state, helper, service reload or external HTTP is used.
  const readFile = fs.readFile.bind(fs), requests = [];
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (String(file) !== '/run/msb-engine/state.json') return readFile(file, ...args);
    let request;
    try { request = JSON.parse(await readFile(path.join(f.home, '.msb/engine/request'), 'utf8')); } catch {}
    if (request && !requests.some(r => r.id === request.id)) requests.push(request);
    return JSON.stringify({ pult: { state: 'running' }, last: request ? { id: request.id, code: 'OK', result: 'done' } : null });
  });
  t.after(() => { clearPendingAuth(42); clearPendingLocalIp(42); });
  return { ...f, turns, requests };
}

const fields = [
  ['password', 'settings:pult'], ['tg-token', 'settings:pult'],
  ['url', 'settings:pult'], ['session', 'settings:pult'],
  ['listen:custom', 'settings:pult:listen'],
];
for (const [field, back] of fields) test(`Pult input: ${field} Back ends only its form before the next task`, async t => {
  const f = await pultFixture(t);
  await f.callback(`settings:pult:${field}`);
  assert.ok(f.editOptions.at(-1).reply_markup.inline_keyboard.flat().some(b => b.text === '« Назад' && b.callback_data === back));
  const before = [...(await readEnvMap()).map];
  await f.callback(back);
  await f.message('ordinary task after going back');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.turns, ['ordinary task after going back']);
  assert.deepEqual([...(await readEnvMap()).map], before);
  assert.deepEqual(f.requests, []);
});

for (const [field, value, key] of [
  ['session', '12', 'PULT_SESSION_HOURS'], ['listen', '127.0.0.1', 'PULT_HOST'],
]) test(`Pult input: choosing the ${field} preset ends the custom input`, async t => {
  const f = await pultFixture(t);
  await f.callback(`settings:pult:${field === 'listen' ? 'listen:custom' : field}`);
  await f.callback(`settings:pult:${field}:set:${value}`);
  assert.equal((await readEnvMap()).map.get(key), value);
  assert.equal(f.requests.length, 1);assert.equal(f.requests[0].action, 'reload-pult');
  const before = [...(await readEnvMap()).map];
  await f.message('ordinary task after choosing preset');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.turns, ['ordinary task after choosing preset']);
  assert.deepEqual([...(await readEnvMap()).map], before);
});

for (const [field] of fields) test(`Pult input: opening ${field} replaces stale provider/IP input ownership`, async t => {
  const f = await pultFixture(t);
  setPendingAuth(42, 'cursor', 42);setPendingLocalIp(42, { chatId: 42 });
  await f.callback(`settings:pult:${field}`);
  assert.equal(getPendingAuth(42), null);
  assert.equal(getPendingLocalIp(42), null);
  assert.deepEqual(f.requests, []);
});

test('Pult input control: unrelated env input is not cancelled by a stale Pult back/listen callback', async t => {
  const f = await pultFixture(t);
  for (const back of ['settings:pult', 'settings:pult:listen']) {
    await f.callback('settings:env:quick:FIXTURE_INPUT_KEY');
    await f.callback(back);
    await f.message('fixture value');
    assert.equal((await readEnvMap()).map.get('FIXTURE_INPUT_KEY'), 'fixture value');
    assert.deepEqual(f.turns, []);
  }
});
