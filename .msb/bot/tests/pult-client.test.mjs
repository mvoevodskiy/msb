import test from 'node:test';
import assert from 'node:assert/strict';
import { listenHostLabel, maskSecret, parseEnvFile } from '../src/pult/client.mjs';

test('parseEnvFile понимает кавычки systemd', () => {
  const m = parseEnvFile('PULT_HOST=0.0.0.0\nPULT_PASSWORD="a b\\"c"\n# skip\n');
  assert.equal(m.get('PULT_HOST'), '0.0.0.0');
  assert.equal(m.get('PULT_PASSWORD'), 'a b"c');
});

test('listenHostLabel', () => {
  assert.match(listenHostLabel('127.0.0.1'), /localhost/);
  assert.match(listenHostLabel('0.0.0.0'), /все интерфейсы/);
  assert.match(listenHostLabel('192.168.1.10'), /192\.168\.1\.10/);
});

test('maskSecret', () => {
  assert.equal(maskSecret(''), 'не задан');
  assert.match(maskSecret('supersecretpassword'), /…word/);
});
