import test from 'node:test';
import assert from 'node:assert/strict';
import { assertChannelPaths } from '../src/path-guards.mjs';

test('ext allows overlay paths', () => {
  assert.doesNotThrow(() => assertChannelPaths('ext', [
    { path: 'bot/run.mjs' },
    { path: 'bot/ext/install.mjs' },
    { path: 'bot/systemd/60-ext-entry.conf' },
  ]));
});

test('ext rejects core bundle', () => {
  assert.throws(() => assertChannelPaths('ext', [{ path: 'bot/index.js' }]));
});

test('core rejects ext paths', () => {
  assert.throws(() => assertChannelPaths('core', [{ path: 'bot/ext/x.mjs' }]));
  assert.doesNotThrow(() => assertChannelPaths('core', [{ path: 'bot/index.js' }, { path: 'puller.cjs' }]));
});
