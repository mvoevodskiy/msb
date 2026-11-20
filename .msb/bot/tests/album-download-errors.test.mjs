/** Download boundary coverage; real bot/queue acceptance is in album-partial-turn.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareAttachment } from '../src/telegram/attachments.mjs';

for (const failure of ['getFile', 'missing path', 'HTTP', 'transport', 'timeout', 'body']) {
  test(`partial album continues once after a ${failure} download failure`, async t => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-album-boundary-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const gets = [], downloads = [];
    const api = {
      async getFile(id) {
        gets.push(id);
        if (id === 'missing' && failure === 'getFile') throw Error('private transport detail');
        if (id === 'missing' && failure === 'missing path') return {};
        return { file_path: id };
      },
    };
    t.mock.method(globalThis, 'fetch', async url => {
      const id = new URL(url).pathname.split('/').at(-1);
      downloads.push(id);
      if (id === 'missing' && failure === 'transport') throw Error(String(url));
      if (id === 'missing' && failure === 'timeout') throw new DOMException(String(url), 'TimeoutError');
      return {
        ok: !(id === 'missing' && failure === 'HTTP'), status: 503,
        async arrayBuffer() {
          if (id === 'missing' && failure === 'body') throw Error(String(url));
          return Uint8Array.from([4, 7, 9]).buffer;
        },
      };
    });

    const prompt = await prepareAttachment({
      ctx: { api, message: {} }, attachment: 'album', env: { MSB_WORKSPACE_DIR: workspace },
      photos: [{ fileId: 'missing' }, { fileId: 'available' }],
    }, 'fixture-sensitive-token', AbortSignal.timeout(5_000));

    const files = [...prompt.matchAll(/^Фото \d+: (.+)$/gm)].map(match => match[1]);
    assert.equal(files.length, 1);
    assert.deepEqual(await fs.readFile(files[0]), Buffer.from([4, 7, 9]));
    assert.deepEqual(gets, ['missing', 'available']);
    assert.deepEqual(downloads, ['getFile', 'missing path'].includes(failure) ? ['available'] : ['missing', 'available']);
    assert.ok(prompt.includes('Исходное фото №1: не удалось скачать'));
    assert.ok(prompt.includes(`Исходное фото №2: ${files[0]}`));
    assert.ok(prompt.endsWith('Что на этом изображении?'));
    assert.doesNotMatch(prompt, /fixture-sensitive-token|private transport detail|api\.telegram\.org/);
  });
}

test('cancellation after reading album bytes prevents saving or downloading the next item', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-album-abort-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const controller = new AbortController();
  const gets = [];
  const api = { async getFile(id) { gets.push(id); return { file_path: id }; } };
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    async arrayBuffer() { controller.abort(); return new ArrayBuffer(4); },
  }));
  await assert.rejects(prepareAttachment({
    ctx: { api, message: {} }, attachment: 'album', env: { MSB_WORKSPACE_DIR: workspace },
    photos: [{ fileId: 'first' }, { fileId: 'second' }],
  }, 'fixture', controller.signal), { name: 'AbortError' });
  assert.deepEqual(gets, ['first']);
  assert.deepEqual(await fs.readdir(workspace), []);
});
