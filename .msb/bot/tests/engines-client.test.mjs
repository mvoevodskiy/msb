import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  engineDir,
  newRequestId,
  requestPath,
  submitRequest,
} from '../src/engines/client.mjs';

test('request id shape', () => {
  const id = newRequestId();
  assert.match(id, /^[a-f0-9]{24}$/);
});

test('submitRequest writes atomic JSON', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-eng-'));
  const env = { HOME: home, MSB_BOT_ID: 'default' };
  const { id, path: req } = await submitRequest('status', { bot_id: 'default' }, env);
  assert.equal(req, requestPath(env));
  assert.ok(engineDir(env).includes('.msb/engine'));
  const raw = await fs.readFile(req, 'utf8');
  const body = JSON.parse(raw);
  assert.equal(body.v, 1);
  assert.equal(body.id, id);
  assert.equal(body.action, 'status');
  assert.equal(body.bot_id, 'default');
});
