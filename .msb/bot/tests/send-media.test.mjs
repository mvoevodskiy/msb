import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendMediaItem, sendMediaQueue } from '../src/telegram/send-media.mjs';

test('sendMediaItem sends local voice and photo through Telegram API methods', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-send-media-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const voice = path.join(home, 'lesson.ogg');
  const photo = path.join(home, 'shot.png');
  await fs.writeFile(voice, Buffer.from('OggSvoice'));
  await fs.writeFile(photo, Buffer.from('PNG'));
  const calls = [];
  const api = {
    sendVoice: async (chatId, media, options) => { calls.push({ method: 'sendVoice', chatId, media, options }); },
    sendPhoto: async (chatId, media, options) => { calls.push({ method: 'sendPhoto', chatId, media, options }); },
  };

  await sendMediaItem(api, 42, { type: 'voice', path: voice, caption: 'часть 1' }, { threadId: 7, env: { MSB_WORKSPACE_DIR: home } });
  await sendMediaItem(api, 42, { type: 'photo', path: 'shot.png' }, { env: { MSB_WORKSPACE_DIR: home } });

  assert.equal(calls[0].method, 'sendVoice');
  assert.equal(calls[0].chatId, 42);
  assert.equal(calls[0].options.caption, 'часть 1');
  assert.equal(calls[0].options.message_thread_id, 7);
  assert.equal(calls[1].method, 'sendPhoto');
  assert.equal(calls[1].options.message_thread_id, undefined);
});

test('sendMediaQueue continues after one failure', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-send-media-q-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const ok = path.join(home, 'ok.bin');
  await fs.writeFile(ok, Buffer.from('ok'));
  const calls = [];
  const logs = [];
  const api = {
    sendDocument: async (_chat, media) => {
      calls.push(media);
      if (calls.length === 1) throw Error('boom');
    },
  };
  await sendMediaQueue(api, 1, [
    { type: 'document', path: ok },
    { type: 'document', path: ok },
  ], { env: { MSB_WORKSPACE_DIR: home }, log: (line) => logs.push(line) });
  assert.equal(calls.length, 2);
  assert.match(logs[0], /send_media failed/);
});
