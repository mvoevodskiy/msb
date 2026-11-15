/** Provider-independent Telegram admission and queue during bot sleep. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSleepGate } from '../src/engines/sleep-gate.mjs';

function fixture({ asleep = true, pending = new Map(), failDelete = false } = {}) {
  const events = [];
  const gate = createSleepGate({ pending, sleeping: async () => asleep,
    notify: async (_ctx, suffix = '') => { events.push(['notice', suffix]); } });
  const message = text => ({ chat: { id: 42 }, message: { message_id: 501, text },
    api: { async deleteMessage(chat, id) { events.push(['delete', chat, id]); if (failDelete) throw Error('denied'); } } });
  return { gate, events, message, next: async () => { events.push(['next']); } };
}

test('awake inputs pass through; sleeping inputs do not reach the model', async () => {
  const awake = fixture({ asleep: false });
  await awake.gate.middleware(awake.message('задача'), awake.next);
  assert.deepEqual(awake.events, [['next']]);
  const sleeping = fixture();
  await sleeping.gate.middleware(sleeping.message('задача'), sleeping.next);
  assert.deepEqual(sleeping.events, [['notice', '']]);
});

test('settings, engine callbacks and an already open form stay accessible', async () => {
  const pending = new Map([[42, 'fixture-form']]);
  const f = fixture({ pending });
  await f.gate.middleware(f.message('/settings'), f.next);
  await f.gate.middleware(f.message('значение формы'), f.next);
  await f.gate.middleware({ chat: { id: 42 }, callbackQuery: { data: 'eng:wake' } }, f.next);
  assert.deepEqual(f.events, [['next'], ['next'], ['next']]);
});

test('the default sleep gate still blocks stop for other providers', async () => {
  const f = fixture();
  await f.gate.middleware(f.message('/stop'), f.next);
  await f.gate.middleware({ ...f.message('стоп'), message: { text: 'стоп', reply_to_message: { message_id: 1 } } }, f.next);
  assert.deepEqual(f.events, [['notice', ''], ['notice', '']]);
});

test('the Codex stop exception does not admit lookalike input', async () => {
  const f = fixture();
  const gate = createSleepGate({ pending: new Map(), sleeping: async () => true,
    notify: async () => { f.events.push(['notice', '']); }, allowStop: async () => true });
  await gate.middleware(f.message('/stopper'), f.next);
  await gate.middleware(f.message('стоп'), f.next);
  await gate.middleware(f.message('/stop@fixture_bot'), f.next);
  assert.deepEqual(f.events, [['notice', ''], ['notice', ''], ['next']]);
});

test('key-like input is removed if possible and failure is reported without echoing it', async () => {
  for (const failDelete of [false, true]) {
    const f = fixture({ failDelete });
    await f.gate.middleware(f.message('sk-ant-synthetic-only'), f.next);
    assert.deepEqual(f.events[0], ['delete', 42, 501]);
    assert.match(f.events[1][1], failDelete ? /не получилось/ : /удалил/);
    assert.doesNotMatch(JSON.stringify(f.events), /sk-ant-synthetic-only/);
  }
});

test('queued ordinary input is stopped and its status removed; recovered and automatic turns stay quiet', async () => {
  const f = fixture();
  for (const flags of [{}, { recovered: true }, { isAutoTurn: true }]) {
    const ctx = f.message('fixture');
    const blocked = await f.gate.queued({ ctx, status: { message_id: 11 }, presentation: Promise.resolve(), ...flags });
    assert.equal(blocked, true);
  }
  assert.deepEqual(f.events, [['delete', 42, 11], ['notice', ''], ['delete', 42, 11]]);
});
