import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';
import { prepareBatch, batchStatus } from '../src/telegram/batch.mjs';

function photoMessage(id) {
  return { message_id: id, date: 1, chat: { id: 42, type: 'private' },
    from: { id: 42, is_bot: false, first_name: 'Owner' },
    photo: [{ file_id: 'small', file_size: 1 }, { file_id: 'photo-' + id, file_size: 4 }],
    caption: 'Подпись ' + id, forward_origin: { type: 'hidden_user', sender_user_name: 'Источник', date: 1 } };
}

test('one forwarded photo and its original caption reach one native Codex turn', async t => {
  const f = await mcpFixture(t, 'codex', { runTurn: runAgentTurn });
  const native = await nativeFixtures(f);
  await native.respond('Получил фотографию.');
  const lookups = [];
  t.mock.method(f.bot.api, 'getFile', async fileId => {
    lookups.push(fileId);
    return { file_path: 'images/' + fileId };
  });
  const bytes = Uint8Array.of(255, 216, 255, 217);
  t.mock.method(globalThis, 'fetch', async url => {
    assert.ok(String(url).endsWith('/images/photo-41'));
    return new Response(bytes);
  });
  await f.bot.handleUpdate({ message: photoMessage(41) });
  const deadline = Date.now() + 10000;
  while (![...f.edits, ...f.messages].some(text => text.includes('Получил фотографию.'))) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for the Codex answer');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const turns = (await native.trace()).filter(row => row.kind === 'codex-app-turn');
  assert.equal(turns.length, 1);
  assert.deepEqual(lookups, ['photo-41']);
  assert.match(turns[0].prompt, /#1 \[Источник\][\s\S]*Подпись 41/);
  const dir = path.join(f.workspace, '.media');
  const files = await fs.readdir(dir);
  assert.equal(files.length, 1);
  const saved = path.join(dir, files[0]);
  assert.ok(turns[0].prompt.includes(saved));
  assert.deepEqual(await fs.readFile(saved), Buffer.from(bytes));
});

test('failed and capped photos retain position and caption without losing following inputs', async t => {
  const f = await mcpFixture(t, 'codex');
  const attempted = [];
  t.mock.method(f.bot.api, 'getFile', async id => {
    attempted.push(id);
    if (id === 'photo-1') throw Error('unavailable');
    return { file_path: id };
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(Uint8Array.of(1, 2, 3, 4)));
  const items = Array.from({ length: 9 }, (_, i) => ({
    ctx: { message: photoMessage(i + 1), api: f.bot.api }, batchAttachment: 'photo',
  }));
  items.push({ comment: true, text: 'Последний комментарий', ctx: { message: {} } });
  assert.match(batchStatus({ items }), /загружаю медиа \(8\)/);
  const prompt = await prepareBatch({ items }, 'fixture', new AbortController().signal);
  assert.deepEqual(attempted, Array.from({ length: 8 }, (_, i) => 'photo-' + (i + 1)));
  assert.match(prompt, /#1 \[Источник\][^\n]*не удалось скачать\nПодпись 1/);
  assert.match(prompt, /#2 \[Источник\][^\n]*\.media\/[^\n]+\nПодпись 2/);
  assert.match(prompt, /#9 \[Источник\][^\n]*предел пачки\)\nПодпись 9[\s\S]*#10 [^\n]*\nПоследний комментарий/);
});
