import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';

async function until(check, label = 'condition') {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error(`Timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

function albumPhoto(f, id, extra = {}) {
  return f.bot.handleUpdate({ message: {
    message_id: id, date: 1, chat: { id: 42 },
    from: { id: 42, is_bot: false, first_name: 'Owner' },
    media_group_id: 'fixture-album', photo: [{ file_id: `photo-${id}`, file_size: 4 }], ...extra,
  } });
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

test('/stop cancels an album still collecting and updates its status', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; }, { overlay: false });
  await albumPhoto(f, 60);
  assert.match(f.messages.at(-1), /Получаю медиа/);
  await f.message('/stop');
  assert.equal(f.messages.at(-1), 'Моя остановочка ✋🏽⛔️');
  await until(() => f.edits.includes('Моя остановочка ✋🏽⛔️'), 'album status after stop');
  assert.equal(calls, 0);
});

test('the album preserves the quoted reply when a later photo has no reply', async t => {
  const prompts = [];
  const f = await fixture(t, async ({ prompt }) => {
    prompts.push(prompt);
    return { ok: true, text: 'Альбом получен.' };
  }, { overlay: false });
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
  }));

  await albumPhoto(f, 61, {
    reply_to_message: { from: { id: 99 }, text: 'Исходное сообщение' },
    quote: { text: 'Выбранная цитата альбома' },
  });
  await albumPhoto(f, 62, { caption: 'Сравни эти фотографии' });
  await until(() => prompts.length === 1, 'album prompt');
  assert.match(prompts[0], /Выбранная цитата альбома/);
  assert.match(prompts[0], /Фото 2:/);
  assert.match(prompts[0], /Сравни эти фотографии/);
});

test('model voice markers are stripped from text and sent as sendVoice', async (t) => {
  const f = await fixture(t, async () => ({
    ok: true,
    text: [
      'Озвучу урок.',
      `[ГОЛОС: ${path.join('runs', 'part.ogg')} Урок 1]`,
      'Готово.',
    ].join('\n'),
  }), { overlay: false });
  await fs.mkdir(path.join(f.workspace, 'runs'), { recursive: true });
  await fs.writeFile(path.join(f.workspace, 'runs', 'part.ogg'), Buffer.from('OggS'));

  await f.message('сделай голос');
  await until(() => f.mediaSends.some(call => call.method === 'sendVoice'), 'voice send');
  const delivered = [...f.messages, ...f.edits].join('\n');
  assert.doesNotMatch(delivered, /\[ГОЛОС:/);
  assert.match(delivered, /Озвучу урок|Готово/);
  assert.equal(f.mediaSends[0].options.caption, 'Урок 1');
});
