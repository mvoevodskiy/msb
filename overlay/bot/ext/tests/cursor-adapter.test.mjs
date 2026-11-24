import test from 'node:test';
import assert from 'node:assert/strict';
import { isCursorSessionId, parseCursorJsonOutput, applyCursorAuthEnv } from '../adapters/cursor.mjs';

test('isCursorSessionId accepts UUID only', () => {
  assert.equal(isCursorSessionId('bf4fd6ef-0ad8-46c3-9486-5422d21d7ac2'), true);
  assert.equal(isCursorSessionId('failed'), false);
  assert.equal(isCursorSessionId('ext:cursor:failed'), false);
  assert.equal(isCursorSessionId('c1730000000'), false);
  assert.equal(isCursorSessionId(''), false);
});

test('parseCursorJsonOutput reads result + session_id', () => {
  const line = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'PONG',
    session_id: '852bdc77-2954-4c84-bdf7-1d3b593a6050',
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
  });
  const data = parseCursorJsonOutput(`warn\n${line}\n`);
  assert.equal(data.result, 'PONG');
  assert.equal(data.session_id, '852bdc77-2954-4c84-bdf7-1d3b593a6050');
});

test('parseCursorJsonOutput empty → null', () => {
  assert.equal(parseCursorJsonOutput(''), null);
  assert.equal(parseCursorJsonOutput('not-json'), null);
});

test('applyCursorAuthEnv drops CURSOR_API_KEY when native login is present', () => {
  const withNative = applyCursorAuthEnv(
    { CURSOR_API_KEY: 'stale-key', PATH: '/bin' },
    { key: 'stale-key', native: true },
  );
  assert.equal(withNative.CURSOR_API_KEY, undefined);
  assert.equal(withNative.PATH, '/bin');

  const keyOnly = applyCursorAuthEnv(
    { CURSOR_API_KEY: 'from-process', PATH: '/bin' },
    { key: 'bot-key', native: false },
  );
  assert.equal(keyOnly.CURSOR_API_KEY, 'bot-key');
});
