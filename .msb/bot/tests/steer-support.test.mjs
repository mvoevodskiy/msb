import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsSteer, usesSteerControlFd } from '../src/agent/steer-support.mjs';

test('supportsSteer covers Claude/Codex/Cursor/Grok only', () => {
  assert.equal(supportsSteer('claude'), true);
  assert.equal(supportsSteer(undefined), true);
  assert.equal(supportsSteer('codex'), true);
  assert.equal(supportsSteer('cursor'), true);
  assert.equal(supportsSteer('grok'), true);
  assert.equal(supportsSteer('qwen'), false);
  assert.equal(supportsSteer('openai'), false);
});

test('overlay FD is for Codex/Cursor/Grok, not Claude stdin', () => {
  assert.equal(usesSteerControlFd('codex'), true);
  assert.equal(usesSteerControlFd('cursor'), true);
  assert.equal(usesSteerControlFd('grok'), true);
  assert.equal(usesSteerControlFd('claude'), false);
});
