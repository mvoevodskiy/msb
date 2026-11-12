import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/menu-fixture.mjs';

async function until(check, label = 'condition') {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error(`Timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

test('photo attachment reaches the agent turn with a saved .media path', async (t) => {
  const prompts = [];
  const f = await fixture(t, async ({ prompt }) => {
    prompts.push(prompt);
    return { ok: true, text: 'Вижу фото.' };
  }, { overlay: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Uint8Array.from([9, 8, 7, 6]).buffer,
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await f.bot.handleUpdate({
    message: {
      message_id: 50, date: 1, chat: { id: 42 },
      from: { id: 42, is_bot: false, first_name: 'Owner' },
      photo: [{ file_id: 'p1', file_size: 4 }],
      caption: 'Опиши',
    },
  });
  await until(() => prompts.length === 1, 'photo prompt');
  assert.match(prompts[0], /Опиши/);
  assert.match(prompts[0], /\.media\//);
  await until(() => f.messages.some(m => /Вижу фото/.test(m)) || f.edits.some(m => /Вижу фото/.test(m)), 'photo answer');
});
