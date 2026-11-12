import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';

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

test('Codex receives one forwarded voice/document batch with its reply in arrival order', async t => {
  const turns = [], downloads = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async turn => {
    turns.push(turn);
    if (turns.length === 1) await held;
    return { ok: true, text: 'Готово.' };
  }, { overlay: false });
  process.env.DEEPGRAM_API_KEY = 'test-stt';
  delete process.env.STT_COMMAND;
  t.mock.method(f.bot.api, 'getFile', async fileId => {
    downloads.push(fileId);
    return { file_path: fileId };
  });
  const document = 'Код документа: DOC-QUEUE-428';
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).startsWith('https://api.deepgram.com/')) {
      return { ok: true, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: 'Фиолетовый компас 428' }] }] } }) };
    }
    const body = String(url).endsWith('/voice.ogg') ? 'OggS' : document;
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  });
  const source = { type: 'hidden_user', sender_user_name: 'Test' };
  const send = (id, message) => f.bot.handleUpdate({ message: {
    message_id: id, date: 1, chat: { id: 42 }, from: { id: 42 }, ...message,
  } });
  try {
    await f.message('предыдущий ход');
    await until(() => turns.length === 1, 'active turn');
    await send(71, { voice: { file_id: 'voice.ogg', duration: 4 }, forward_origin: source });
    await send(72, {
      document: { file_id: 'doc.txt', file_name: 'doc.txt', mime_type: 'text/plain', file_size: 55 },
      caption: 'Подпись документа', forward_origin: source,
    });
    await send(73, {
      text: 'Проверь пачку', reply_to_message: { from: { id: 42 }, text: 'Полное сообщение' },
      quote: { text: 'Контрольная цитата' },
    });
    assert.deepEqual(downloads, [], 'queued batch must not start in parallel');
  } finally { release(); }
  await until(() => turns.length === 2, 'forwarded batch reaches Codex');
  const { prompt, requireCodex } = turns[1];
  assert.match(prompt, /пачку из 3 сообщений/);
  assert.match(prompt, /#1 [^\n]*голосовое[\s\S]*Фиолетовый компас 428[\s\S]*#2 [^\n]*файл doc\.txt[^\n]*\/\.media\/[\s\S]*Подпись документа[\s\S]*Код документа: DOC-QUEUE-428[\s\S]*#3 [^\n]*комментарий пользователя[\s\S]*Контрольная цитата[\s\S]*Проверь пачку/);
  assert.doesNotMatch(prompt, /Полное сообщение/);
  assert.deepEqual(downloads, ['voice.ogg', 'doc.txt']);
  assert.equal(requireCodex, true);
  assert.ok([...f.messages, ...f.edits].some(text => text.includes('загружаю медиа (2)')));
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

test('Claude and OpenClaw keep their existing attachment and reply behavior', async t => {
  const f = await fixture(t, async () => ({ ok: true, text: 'Обычный ответ.\n[ФАЙЛ: local.txt]' }), { overlay: false });
  await fs.writeFile(path.join(f.workspace, 'local.txt'), 'fixture');
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected attachment download'));
  for (const engine of ['cc', 'oc']) {
    await saveState({ ...(await loadState()).state, engine, extAuthBypass: 'claude', authMode: 'subscription', hasSubscriptionAuth: true });
    await albumPhoto(f, 70);
    assert.match(f.messages.at(-1), /Обработка вложений .* пока не подключена/);
    await f.message('/help');
    assert.match(f.messages.at(-1), /вложений в open-core пока не подключена/);
    const before = f.edits.length;
    await f.message('обычное сообщение');
    await until(() => f.edits.slice(before).some(text => text.includes('Обычный ответ.')), 'existing text response');
    assert.ok(f.edits.slice(before).some(text => text.includes('[ФАЙЛ:')));
    assert.equal(f.mediaSends.length, 0);
  }
});

test('Codex attachment turn sends a relative file from the captured project', async t => {
  const f = await mcpFixture(t, 'codex', { runTurn: runAgentTurn });
  const native = await nativeFixtures(f);
  const project = path.join(f.home, 'projects', 'media-fixture');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'project-only.txt'), 'fixture project result');
  await saveState({ ...(await loadState()).state, activeProject: 'media-fixture' });
  await native.respond('Вложение обработано.\n[ФАЙЛ: project-only.txt]');
  const incoming = Buffer.from('attachment contents fixture');
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, arrayBuffer: async () => Uint8Array.from(incoming).buffer,
  }));

  await f.bot.handleUpdate({ message: {
    message_id: 63, date: 1, chat: { id: 42 },
    from: { id: 42, is_bot: false, first_name: 'Owner' },
    document: { file_id: 'doc', file_name: 'note.txt', file_size: incoming.length, mime_type: 'text/plain' },
  } });
  await until(() => f.edits.some(text => text.includes('Вложение обработано')), 'Codex attachment answer');
  await f.bot.stop();
  const call = (await native.trace()).find(row => row.kind === 'codex-exec');
  assert.equal(call.cwd, await fs.realpath(project));
  assert.match(call.prompt, /attachment contents fixture/);
  assert.equal(f.mediaSends.length, 1);
  assert.equal(f.mediaSends[0].method, 'sendDocument');
  assert.equal(f.mediaSends[0].media.filename, 'project-only.txt');
});
