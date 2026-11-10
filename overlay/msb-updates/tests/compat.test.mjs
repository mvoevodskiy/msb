import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCoreVersions, isCoreCompatible, pickCompatibleExt } from '../src/compat.mjs';

test('platform version compare', () => {
  assert.ok(compareCoreVersions('2026-10-20-x.v27.178', '2026-10-20-x.v27.100') > 0);
  assert.equal(compareCoreVersions('2026-10-20-x.v27.178', '2026-10-20-x.v27.178'), 0);
});

test('compatible min', () => {
  assert.equal(isCoreCompatible('2026-10-20-x.v27.178', { min: '2026-10-20-x.v27.100' }), true);
  assert.equal(isCoreCompatible('2026-10-20-x.v27.50', { min: '2026-10-20-x.v27.100' }), false);
});

test('compatible versions list wins', () => {
  assert.equal(isCoreCompatible('a', { min: 'z', versions: ['a'] }), true);
  assert.equal(isCoreCompatible('b', { min: 'a', versions: ['a'] }), false);
});

test('pickCompatibleExt', () => {
  const rel = pickCompatibleExt([
    { version: '0.1.0', compatible_core: { min: 'x.v27.200' } },
    { version: '0.2.0', compatible_core: { min: 'x.v27.100' } },
  ], 'x.v27.150');
  assert.equal(rel.version, '0.2.0');
});
