import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichPath, cliPresent } from '../ensure-cli.mjs';
import { extToolsBin } from '../paths.mjs';
import os from 'node:os';
import path from 'node:path';

test('enrichPath puts ext-tools and .local/bin first', () => {
  const home = '/tmp/fake-home-msb';
  const p = enrichPath({ PATH: '/usr/bin' }, home);
  const parts = p.split(path.delimiter);
  assert.equal(parts[0], extToolsBin(home));
  assert.ok(parts.includes(path.join(home, '.local', 'bin')));
  assert.ok(parts.includes('/usr/bin'));
});

test('cliPresent claude always ok', () => {
  const r = cliPresent('claude', process.env);
  assert.equal(r.ok, true);
});

test('cliPresent unknown missing without install', () => {
  const r = cliPresent('cursor', { PATH: '/nonexistent/bin' });
  assert.equal(r.ok, false);
});
