import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { fixtureSystemd } from './helpers/systemd-fixture.mjs';
import { pultScreen } from '../src/telegram/screens.mjs';
import { loadState } from '../src/state.mjs';
import { readEnvMap } from '../src/env/store.mjs';

const TASKS = Symbol.for('msb.callbackTasks');
const UNKNOWN = /нет данных.*служб/i;
const ON = { installed: true, enabled: true, active: true, root: '/fixture/.iia/pult' };
async function statusFixture(t, { initial = null, outcome = 'OK', fresh = ON, held = false, systemd = { 'msb-engine.path': 'active' } } = {}) {
  let turnEntered;
  const turn = new Promise(resolve => { turnEntered = resolve; });
  const turns = [];
  const f = await fixture(t, async ({ prompt }) => { turns.push(prompt);turnEntered(prompt);return { ok: true, text: 'fixture' }; }, { runtimeProfile: 'jar1' });
  await fixtureSystemd(t, systemd);
  const slot = path.join(f.home, '.iia/engine/request'), read = fs.readFile.bind(fs), requests = [];
  let released = !held, snapshot = initial;
  t.mock.method(fs, 'readFile', async (file,...args) => {
    if (String(file) !== '/run/msb-engine/state.json') return read(file,...args);
    let request;
    try { request = JSON.parse(await read(slot, 'utf8'));await fs.unlink(slot);requests.push(request); } catch {}
    const last = requests.at(-1);
    if (last && released && outcome === 'OK') snapshot = fresh;
    if (!snapshot && !last) throw Object.assign(Error('fixture /run lost after reboot'), { code: 'ENOENT' });
    return JSON.stringify({ pult: snapshot,
      last: last && outcome !== 'TIMEOUT' ? { id: last.id, code: released ? outcome : 'RUNNING', result: !released ? 'running' : outcome === 'OK' ? 'done' : 'refused' } : null });
  });
  return { ...f, requests, turn, turns, release() { released = true; },
    async refresh(data = 'settings:pult:refresh') { await f.callback(data);await Promise.all([...(f.bot[TASKS] || [])]); } };
}

test('Pult status: missing or incomplete helper data is unknown, never a claim of missing installation', () => {
  for (const snapshot of [null, {}, { installed: true }, { installed: false }]) {
    const view = pultScreen(snapshot);
    assert.match(view.text, UNKNOWN);assert.doesNotMatch(view.text, /код не найден|выключен|службы работают/);
    assert.ok(!view.keyboard.inline_keyboard.flat().some(b => ['settings:pult:on','settings:pult:off'].includes(b.callback_data)));
  }
});

test('Pult status: an observed web service does not imply a running collector or known controls', () => {
  const view = pultScreen(null, {}, '', { web: 'active', collector: null });
  assert.match(view.text, /Веб-служба: работает/);
  assert.match(view.text, /Сборщик: нет данных/);
  assert.ok(!view.keyboard.inline_keyboard.flat().some(button => button.callback_data === 'settings:pult:off'));
});

test('Pult status: a confirmed incomplete installation reports the actual profile root', () => {
  const view = pultScreen({ installed: false, enabled: false, active: false, root: '/fixture/.iia/pult' });
  assert.ok(view.text.includes('/fixture/.iia/pult'));assert.ok(!view.text.includes('~/.msb/pult'));
});

test('Pult status: opening after /run loss shows unknown without inventing an install failure or changing settings', async t => {
  const f = await statusFixture(t), before = (await loadState()).state;
  await f.callback('settings:pult');
  assert.match(f.edits.at(-1), UNKNOWN);assert.deepEqual(f.requests, []);
  assert.deepEqual((await loadState()).state, before);assert.equal((await readEnvMap()).map.size, 0);
});

test('Pult status: the existing Refresh button performs one real status round trip and shows fresh helper data in jar1', async t => {
  const f = await statusFixture(t, { initial: { ...ON, installed: false, enabled: false, active: false } });
  await f.callback('settings:pult');
  const refresh = f.editOptions.at(-1).reply_markup.inline_keyboard.flat().find(b => b.text === '🔄 Обновить');
  assert.ok(refresh);
  await f.refresh(refresh.callback_data);
  assert.equal(f.requests.length, 1);assert.equal(f.requests[0].action, 'status');assert.equal(f.requests[0].bot_id, 'default');
  assert.match(f.edits.at(-1), /включён, службы работают/);
  assert.ok(f.editOptions.at(-1).reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'settings:pult:off'));
  assert.equal((await readEnvMap()).map.size, 0);
});

for (const [label, options, expected] of [
  ['refused', { initial: ON, outcome: 'RATE_LIMITED' }, /RATE_LIMITED/],
  ['incomplete success', { initial: ON, fresh: { installed: true } }, /полный статус/],
  ['no answer', { initial: ON, outcome: 'TIMEOUT' }, /нет ответа/],
]) test(`Pult status: ${label} does not present stale cache as a fresh successful status`, async t => {
  const f = await statusFixture(t, options);
  if (options.outcome === 'TIMEOUT') { let clock = 0;t.mock.method(Date, 'now', () => clock += 21_000); }
  await f.refresh();
  assert.match(f.edits.at(-1), UNKNOWN);assert.match(f.edits.at(-1), expected);
  assert.doesNotMatch(f.edits.at(-1), /helper|помощник/i);
  assert.doesNotMatch(f.edits.at(-1), /включён, службы работают/);
  assert.equal((await readEnvMap()).map.size, 0);
});

test('Pult shows running services when the system watcher has stopped and leaves a queued operation intact', async t => {
  const f = await fixture(t, undefined, { runtimeProfile: 'jar1' });
  await fixtureSystemd(t, {
    'msb-engine.path': 'inactive',
    'pult-web.service': 'active',
    'pult-collector.service': 'active',
  });
  const read = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (String(file) === '/run/msb-engine/state.json') {
      throw Object.assign(Error('synthetic missing status'), { code: 'ENOENT' });
    }
    return read(file, ...args);
  });
  const slot = path.join(f.home, '.iia/engine/request');
  await fs.mkdir(path.dirname(slot), { recursive: true });

  await f.callback('settings:pult');
  assert.match(f.edits.at(-1), /Веб-служба: работает/);
  assert.match(f.edits.at(-1), /Сборщик: работает/);
  assert.ok(!f.editOptions.at(-1).reply_markup.inline_keyboard.flat().some(button =>
    ['settings:pult:on', 'settings:pult:off'].includes(button.callback_data)));

  for (const occupied of [false, true]) {
    const old = '{"v":1,"action":"reload-pult"}\n';
    if (occupied) await fs.writeFile(slot, old);
    const before = occupied ? await fs.stat(slot) : null;
    await f.callback('settings:pult:refresh');
    await Promise.all([...(f.bot[TASKS] || [])]);
    assert.match(f.edits.at(-1), /системная служба не запущена/iu);
    assert.match(f.edits.at(-1), /Сборщик: работает/);
    if (occupied) {
      assert.equal(await read(slot, 'utf8'), old);
      assert.equal((await fs.stat(slot)).ino, before.ino);
    } else {
      await assert.rejects(fs.stat(slot), { code: 'ENOENT' });
    }
  }
});

test('Pult cold status publishes once when the watcher is active or its state is unknown', async t => {
  for (const systemd of [{ 'msb-engine.path': 'active' }, {}]) {
    await t.test(systemd['msb-engine.path'] ?? 'unknown', async t => {
      const f = await statusFixture(t, { systemd });
      await f.refresh();
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].action, 'status');
      assert.match(f.edits.at(-1), /включён, службы работают/);
    });
  }
});

test('Pult switch timeout names the system service and preserves existing controls', async t => {
  const f = await statusFixture(t, { initial: ON, outcome: 'TIMEOUT' });
  let clock = 0;
  t.mock.method(Date, 'now', () => clock += 100_000);
  await f.callback('settings:pult:off');
  assert.match(f.edits.at(-1), /нет ответа системной службы/);
  assert.doesNotMatch(f.edits.at(-1), /helper|помощник/i);
  assert.ok(f.editOptions.at(-1).reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'settings:pult:refresh'));
});

test('Pult status: Refresh leaves Pult input before asynchronous work and the next task is not consumed as a value', async t => {
  const f = await statusFixture(t, { held: true });
  await f.callback('settings:pult:session');
  await f.callback('settings:pult:refresh');
  await f.message('ordinary task after refresh navigation');
  let timeout;
  try {
    const prompt = await Promise.race([f.turn, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Task was consumed by the old Pult form')), 1_000); })]);
    assert.equal(prompt, 'ordinary task after refresh navigation');
  } finally { clearTimeout(timeout);f.release();await Promise.all([...(f.bot[TASKS] || [])]); }
  assert.equal((await readEnvMap()).map.size, 0);
});

test('Pult status: an obsolete Refresh cannot clear a newly opened Pult form after its state read resumes', async t => {
  const f = await statusFixture(t), read = fs.readFile.bind(fs);
  let first = true, entered, release;
  const paused = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(fs, 'readFile', async (file,...args) => {
    const raw = await read(file,...args);
    if (first && String(file).endsWith('/state.json') && !String(file).startsWith('/run/')) { first = false;entered();await gate; }
    return raw;
  });
  try {
    await f.callback('settings:pult:refresh');await paused;
    await f.callback('settings:pult:session');
    release();await Promise.all([...(f.bot[TASKS] || [])]);
    await f.message('12');
    assert.equal((await readEnvMap()).map.get('PULT_SESSION_HOURS'), '12');
    assert.deepEqual(f.turns, []);
  } finally { release();await Promise.all([...(f.bot[TASKS] || [])]); }
});
