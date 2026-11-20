/** Telegram album ingress with fixture downloads, disk writes and the shared turn runner. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './helpers/menu-fixture.mjs';

const answer = 'Ответ по альбому.';
const partialHeading = 'Состав исходного альбома (часть вложений недоступна):';
const stopped = 'Моя остановочка ✋🏽⛔️';

async function until(check, label) {
  const deadline = performance.now() + 7000;
  while (!check()) {
    if (performance.now() > deadline) throw Error(`Timed out waiting for ${label}`);
    await delay(10);
  }
}

async function albumFixture(t, transfers) {
  const prompts = [], getFiles = [], fetches = [];
  const f = await fixture(t, async ({ prompt }) => {
    prompts.push(prompt);
    return { ok: true, text: answer };
  }, { overlay: false });
  t.mock.method(f.bot.api, 'getFile', async (fileId, signal) => {
    getFiles.push(fileId);
    const transfer = transfers[fileId];
    assert.ok(transfer, `unexpected getFile for ${fileId}`);
    await transfer.beforeGetFile?.(signal);
    if (transfer.failure === 'getFile') throw Error('fixture getFile rejected');
    return { file_path: fileId };
  });
  t.mock.method(globalThis, 'fetch', async url => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://api.telegram.org');
    const fileId = target.pathname.split('/').at(-1);
    fetches.push(fileId);
    const transfer = transfers[fileId];
    assert.ok(transfer, `unexpected fetch for ${fileId}`);
    if (transfer.failure === 'HTTP') return { ok: false, status: 503 };
    return {
      ok: true,
      arrayBuffer: async () => {
        if (transfer.failure === 'body') throw Error('fixture body interrupted');
        return Uint8Array.from(transfer.bytes).buffer;
      },
    };
  });
  const send = async (...messages) => {
    for (const [i, media] of messages.entries()) {
      await f.bot.handleUpdate({ message: {
        message_id: i + 1, date: 1, chat: { id: 42 }, from: { id: 42, first_name: 'Owner' },
        media_group_id: 'fixture-album', ...media,
      } });
    }
  };
  const settle = async () => {
    await until(() => f.messages.some(text => text.startsWith(answer) || text.startsWith('❌ Ошибка:')), 'album outcome');
    await f.bot.stop();
  };
  return { ...f, prompts, getFiles, fetches, send, settle };
}

function photo(fileId, extra = {}) {
  return { photo: [{ file_id: fileId }], ...extra };
}

function video(fileId) {
  return { video: { file_id: fileId, duration: 4 } };
}

function document(fileId, name, type) {
  return { document: { file_id: fileId, file_name: name, mime_type: type, file_size: 10 } };
}

function imagePaths(prompt) {
  return [...prompt.matchAll(/^Фото \d+: (.+)$/gm)].map(line => line[1]);
}

function partialPrompt(f) {
  assert.equal(f.prompts.length, 1, `one agent turn expected, final message: ${f.messages.at(-1)}`);
  const [prompt] = f.prompts;
  assert.ok(prompt.includes(partialHeading));
  assert.ok([...f.messages, ...f.edits].every(text => !text.includes(partialHeading)), 'album details stay in the model prompt');
  assert.match(f.messages.at(-1), /^Ответ по альбому\./);
  return prompt;
}

const photos = ['p1', 'p2', 'p3'];
const photoBytes = photos.map((_, i) => Buffer.from([i + 1, 8, 9]));
for (const [failedIndex, failure] of ['getFile', 'HTTP', 'body'].entries()) {
  test(`partial photo album survives ${failure} failure at original position ${failedIndex + 1}`, async t => {
    const transfers = Object.fromEntries(photos.map((id, i) => [id, i === failedIndex ? { failure } : { bytes: photoBytes[i] }]));
    const f = await albumFixture(t, transfers);
    const suppliedContext = {
      caption: 'Сравни кадры альбома',
      reply_to_message: { from: { id: 99 }, text: 'Полный текст исходного сообщения' },
      quote: { text: 'Выбранная цитата' },
    };
    await f.send(...photos.map((id, i) => photo(id, failure === 'getFile' && i === failedIndex ? suppliedContext : {})));
    await f.settle();

    const prompt = partialPrompt(f);
    assert.deepEqual(f.getFiles, photos, 'one attempt per original element');
    assert.deepEqual(f.fetches, failure === 'getFile' ? photos.slice(1) : photos);
    const paths = imagePaths(prompt);
    const available = photos.map((_, i) => i).filter(i => i !== failedIndex);
    assert.deepEqual(await Promise.all(paths.map(file => fs.readFile(file))), available.map(i => photoBytes[i]));
    assert.ok(prompt.includes(`Исходное фото №${failedIndex + 1}: не удалось скачать`));
    for (const [i, originalIndex] of available.entries()) {
      assert.ok(prompt.includes(`Исходное фото №${originalIndex + 1}: ${paths[i]}`));
    }
    if (failure === 'getFile') {
      assert.ok(prompt.startsWith('[Реплай.'));
      assert.match(prompt, /Выбранная цитата/);
      assert.doesNotMatch(prompt, /Полный текст исходного сообщения/);
      assert.ok(prompt.endsWith(suppliedContext.caption));
    } else {
      assert.ok(prompt.endsWith('Галерея из 2 изображений. Проанализируй.'));
    }
  });
}

test('a mixed album keeps a saved MP4 when other elements fail and ffmpeg yields no insights', async t => {
  const bytes = Buffer.from('synthetic MP4 fixture');
  const f = await albumFixture(t, {
    p1: { failure: 'getFile' }, v1: { bytes }, v2: { failure: 'HTTP' },
  });
  const bin = path.join(f.home, 'bin');
  const ffmpegCalls = path.join(f.home, 'ffmpeg-calls');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'ffmpeg'), '#!/bin/sh\nprintf called >> "$ALBUM_FFMPEG_CALLS"\nexit 1\n', { mode: 0o700 });
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.ALBUM_FFMPEG_CALLS = ffmpegCalls;

  await f.send(photo('p1'), video('v1'), video('v2'));
  await f.settle();

  const prompt = partialPrompt(f);
  assert.deepEqual(f.getFiles, ['p1', 'v1', 'v2']);
  assert.deepEqual(f.fetches, ['v1', 'v2']);
  assert.match(await fs.readFile(ffmpegCalls, 'utf8'), /called/);
  assert.deepEqual(imagePaths(prompt), []);
  const saved = prompt.match(/^Файл: (.+\.mp4)$/m)?.[1];
  assert.ok(saved);
  assert.deepEqual(await fs.readFile(saved), bytes);
  assert.ok(prompt.includes('Исходное фото №1: не удалось скачать'));
  assert.ok(prompt.includes(`Исходное видео №1: ${saved}`));
  assert.ok(prompt.includes('Исходное видео №2: не удалось скачать'));
  assert.ok(prompt.endsWith('Проанализируй это видео.'));
});

test('a document album keeps saved image and text bytes after failures of both document kinds', async t => {
  const jpeg = Buffer.from([255, 216, 255, 217]);
  const text = Buffer.from('Fixture inline document');
  const f = await albumFixture(t, {
    d1: { failure: 'HTTP' }, d2: { bytes: jpeg }, d3: { failure: 'body' }, d4: { bytes: text },
  });
  await f.send(document('d1', 'lost.jpg', 'image/jpeg'), document('d2', 'saved.jpg', 'image/jpeg'),
    document('d3', 'lost.txt', 'text/plain'), document('d4', 'saved.txt', 'text/plain'));
  await f.settle();

  const prompt = partialPrompt(f);
  assert.deepEqual(f.getFiles, ['d1', 'd2', 'd3', 'd4']);
  assert.deepEqual(f.fetches, f.getFiles);
  const [image] = imagePaths(prompt);
  const saved = prompt.match(/^Файл: (.+saved\.txt)$/m)?.[1];
  assert.ok(image && saved);
  assert.deepEqual(await fs.readFile(image), jpeg);
  assert.deepEqual(await fs.readFile(saved), text);
  assert.ok(prompt.includes(text.toString()));
  assert.ok(prompt.includes('Исходный документ №1 (lost.jpg): не удалось скачать'));
  assert.ok(prompt.includes(`Исходный документ №2 (saved.jpg): ${image}`));
  assert.ok(prompt.includes('Исходный документ №3 (lost.txt): не удалось скачать'));
  assert.ok(prompt.includes(`Исходный документ №4 (saved.txt): ${saved}`));
  assert.ok(prompt.endsWith('Проанализируй файлы'));
});

test('an entirely unavailable album tries each element once and displays the first existing error', async t => {
  const f = await albumFixture(t, { p1: { failure: 'HTTP' }, p2: { failure: 'getFile' }, p3: { failure: 'body' } });
  await f.send(...photos.map(id => photo(id)));
  await f.settle();

  assert.deepEqual(f.getFiles, photos);
  assert.deepEqual(f.fetches, ['p1', 'p3']);
  assert.deepEqual(f.prompts, []);
  assert.equal(f.messages.at(-1), '❌ Ошибка: Не удалось скачать файл: HTTP 503');
});

test('/stop during a held album getFile prevents the next download and retires the status', async t => {
  const gate = Promise.withResolvers();
  let getFileSignal;
  const f = await albumFixture(t, {
    p1: { failure: 'getFile', beforeGetFile: signal => { getFileSignal = signal; return gate.promise; } },
    p2: { bytes: photoBytes[1] },
  });
  try {
    await f.send(photo('p1'), photo('p2'));
    await until(() => Boolean(getFileSignal), 'the first active getFile');
    await f.message('/stop');
    assert.equal(getFileSignal.aborted, true);
  } finally {
    gate.resolve();
  }
  await until(() => f.edits.includes(stopped), 'the stopped album status');
  await f.bot.stop();

  assert.deepEqual(f.getFiles, ['p1']);
  assert.deepEqual(f.fetches, []);
  assert.deepEqual(f.prompts, []);
  assert.equal(f.messages.at(-1), stopped);
  assert.ok(f.messages.every(text => !text.startsWith('❌ Ошибка:')));
});

test('a local album write error remains fatal even though a subsequent photo is available', async t => {
  const f = await albumFixture(t, { p1: { bytes: photoBytes[0] }, p2: { bytes: photoBytes[1] } });
  const media = path.join(f.workspace, '.media');
  const writeFile = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (path.dirname(String(file)) === media) throw Object.assign(Error('fixture write denied'), { code: 'ENOSPC' });
    return writeFile(file, ...args);
  });
  await f.send(photo('p1'), photo('p2'));
  await f.settle();

  assert.deepEqual(f.getFiles, ['p1']);
  assert.deepEqual(f.fetches, ['p1']);
  assert.deepEqual(f.prompts, []);
  assert.equal(f.messages.at(-1), '❌ Ошибка: fixture write denied');
});

test('a local read error for a downloaded inline document remains fatal', async t => {
  const bytes = Buffer.from('synthetic document fixture');
  const f = await albumFixture(t, { d1: { bytes }, d2: { bytes } });
  const media = path.join(f.workspace, '.media');
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (path.dirname(String(file)) === media) throw Object.assign(Error('fixture read denied'), { code: 'EIO' });
    return readFile(file, ...args);
  });
  await f.send(document('d1', 'first.txt', 'text/plain'), document('d2', 'second.txt', 'text/plain'));
  await f.settle();

  assert.deepEqual(f.getFiles, ['d1']);
  assert.deepEqual(f.fetches, ['d1']);
  assert.deepEqual(f.prompts, []);
  assert.equal(f.messages.at(-1), '❌ Ошибка: fixture read denied');
});
