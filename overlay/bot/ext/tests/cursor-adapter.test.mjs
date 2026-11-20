import test from 'node:test';
import assert from 'node:assert/strict';
import { isCursorSessionId, parseCursorJsonOutput } from '../adapters/cursor.mjs';

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
