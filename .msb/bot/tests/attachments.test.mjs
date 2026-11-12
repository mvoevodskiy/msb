import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareAttachment } from '../src/telegram/attachments.mjs';

test('prepareAttachment saves a photo under workspace .media and builds a Read prompt', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-attach-'));
  const workspace = path.join(home, 'workspace');
  await fs.mkdir(workspace);
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const previous = { ...process.env };
  process.env.MSB_WORKSPACE_DIR = workspace;
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });

  const api = {
    getFile: async () => ({ file_path: 'photos/x.jpg', file_size: 4 }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const ctx = {
    api,
    me: { id: 1 },
    message: {
      photo: [{ file_id: 'small', file_size: 1 }, { file_id: 'best', file_size: 4 }],
      caption: 'Что на фото?',
    },
  };
  const prompt = await prepareAttachment({ ctx, attachment: 'photo' }, 'token', AbortSignal.timeout(5_000));
  assert.match(prompt, /Что на фото\?/);
  assert.match(prompt, /Файл уже сохранён/);
  assert.match(prompt, /\.media\//);
  const mediaRoot = path.join(workspace, '.media');
  const files = await fs.readdir(mediaRoot);
  assert.equal(files.length, 1);
  assert.equal((await fs.readFile(path.join(mediaRoot, files[0]))).length, 4);
});

test('prepareAttachment inlines small text documents and keeps the path', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-doc-'));
  const workspace = path.join(home, 'workspace');
  await fs.mkdir(workspace);
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  process.env.MSB_WORKSPACE_DIR = workspace;
  t.after(() => { delete process.env.MSB_WORKSPACE_DIR; });

  const body = 'hello from attachment\n';
  const api = { getFile: async () => ({ file_path: 'docs/note.md', file_size: body.length }) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Uint8Array.from(Buffer.from(body)).buffer,
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const ctx = {
    api,
    message: {
      document: { file_id: 'doc', file_name: 'note.md', file_size: body.length, mime_type: 'text/markdown' },
      caption: 'Разбери файл',
    },
  };
  const prompt = await prepareAttachment({ ctx, attachment: 'document' }, 'token', AbortSignal.timeout(5_000));
  assert.match(prompt, /hello from attachment/);
  assert.match(prompt, /note\.md/);
  assert.match(prompt, /Разбери файл/);
  assert.match(prompt, /\.media\//);
});
