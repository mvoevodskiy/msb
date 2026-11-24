import test from 'node:test';
import assert from 'node:assert/strict';
import { isGrokSessionId, parseGrokJsonOutput, applyGrokAuthEnv } from '../adapters/grok.mjs';

test('isGrokSessionId accepts native ids and rejects sentinels', () => {
  assert.equal(isGrokSessionId('bf4fd6ef-0ad8-46c3-9486-5422d21d7ac2'), true);
  assert.equal(isGrokSessionId('sess_abc123'), true);
  assert.equal(isGrokSessionId('failed'), false);
  assert.equal(isGrokSessionId('ext:grok:failed'), false);
  assert.equal(isGrokSessionId('norestart'), false);
  assert.equal(isGrokSessionId('c1730000000'), false);
  assert.equal(isGrokSessionId(''), false);
});

test('parseGrokJsonOutput reads text + sessionId', () => {
  const line = JSON.stringify({
    text: 'PONG',
    stopReason: 'end_turn',
    sessionId: '852bdc77-2954-4c84-bdf7-1d3b593a6050',
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  const data = parseGrokJsonOutput(`warn\n${line}\n`);
  assert.equal(data.text, 'PONG');
  assert.equal(data.sessionId, '852bdc77-2954-4c84-bdf7-1d3b593a6050');
  assert.equal(data.stopReason, 'end_turn');
});

test('parseGrokJsonOutput empty → null', () => {
  assert.equal(parseGrokJsonOutput(''), null);
  assert.equal(parseGrokJsonOutput('not-json'), null);
});

test('applyGrokAuthEnv drops XAI_API_KEY when native login is present', () => {
  const withNative = applyGrokAuthEnv(
    { XAI_API_KEY: 'stale-key', PATH: '/bin' },
    { key: 'stale-key', native: true },
  );
  assert.equal(withNative.XAI_API_KEY, undefined);

  const keyOnly = applyGrokAuthEnv(
    { XAI_API_KEY: 'from-process' },
    { key: 'bot-key', native: false },
  );
  assert.equal(keyOnly.XAI_API_KEY, 'bot-key');
});
