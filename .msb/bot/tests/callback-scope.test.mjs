import test from 'node:test';
import assert from 'node:assert/strict';
import { beginCallbackRender, runCallbackScope, stopCallbackRenders, drainCallbackTasks } from '../shared/callback-renders.mjs';
import { editOrReply } from '../../../overlay/bot/ext/integration/shared.mjs';

function fixture(t) {
  const calls = [], bot = { api: {
    editMessageText: async (_chat,_id,text) => { calls.push(text); },
    sendMessage: async (_chat,text) => { calls.push(text); },
  } };
  t.after(async () => { stopCallbackRenders(bot);await drainCallbackTasks(bot); });
  const scope = () => beginCallbackRender(bot, { message: { chat: { id: 42 } } });
  return { bot, calls, scope };
}

test('callback scope: detached provider-view continuation can update its still-selected screen after the handler returns', async t => {
  const f = fixture(t);let release, continuation;
  const gate = new Promise(resolve => { release = resolve; });
  await runCallbackScope(f.scope(), async () => {
    await editOrReply(f.bot, 42, 1, 'provider waiting', {});
    continuation = gate.then(() => editOrReply(f.bot, 42, 1, 'provider completed', {}));
  });
  release();await continuation;
  assert.deepEqual(f.calls, ['provider waiting', 'provider completed']);
});

test('callback scope: an old detached provider continuation cannot adopt a newer callback scope', async t => {
  const f = fixture(t);let release, continuation;
  const gate = new Promise(resolve => { release = resolve; });
  await runCallbackScope(f.scope(), async () => {
    await editOrReply(f.bot, 42, 1, 'provider waiting', {});
    continuation = gate.then(() => editOrReply(f.bot, 42, 1, 'late provider view', {}));
  });
  await runCallbackScope(f.scope(), () => editOrReply(f.bot, 42, 1, 'new selected view', {}));
  release();await continuation;
  assert.deepEqual(f.calls, ['provider waiting', 'new selected view']);
});
