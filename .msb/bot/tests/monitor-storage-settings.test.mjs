/** The Telegram settings screen reports the backend used by poll and digest. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { defaultConfig, saveMonitorConfig, loadMonitorConfig } from '../src/monitor/config.mjs';

test('monitoring settings identify JSONL and mark SQLite unavailable', async t => {
  const f = await fixture(t);
  await f.callback('mon:settings');
  assert.match(f.edits.at(-1), /Фактическое хранилище:.*JSONL/);
  assert.match(f.edits.at(-1), /SQLite пока недоступен/);
  const buttons = f.editOptions.at(-1).reply_markup.inline_keyboard.flat();
  assert.match(buttons.find(button => button.callback_data === 'mon:storage:set:sqlite')?.text ?? '', /SQLite.*недоступ/iu);
});

test('an old SQLite callback leaves the monitor config and existing data alone', async t => {
  const f = await fixture(t);
  const file = path.join(f.home, '.msb/monitor/config.json');
  await f.callback('mon:storage:set:sqlite');
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.match(f.edits.at(-1), /SQLite пока недоступен/);

  const previous = { ...defaultConfig(), storage: 'sqlite' };
  await saveMonitorConfig(previous);
  const original = await fs.readFile(file, 'utf8');
  await f.callback('mon:settings');
  assert.match(f.edits.at(-1), /Фактическое хранилище:.*JSONL/);
  await f.callback('mon:storage:set:sqlite');
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await f.callback('mon:storage:set:jsonl');
  assert.equal((await loadMonitorConfig()).storage, 'jsonl');
});
