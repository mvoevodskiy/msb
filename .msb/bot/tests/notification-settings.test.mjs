/** The existing nm:list route reads only the owner and server mute records. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';

const mutes = (...names) => ({ kinds: Object.fromEntries(names.map(name => [
  name, { mutedAt: '2026-11-24T00:00:00.000Z' },
])) });

async function writeMutes(dir, value) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'notice-mute.json');
  const data = typeof value === 'string' ? value : JSON.stringify(value);
  await fs.writeFile(file, data);
  return { file, data };
}

test('notification settings list saved choices only from their old scopes', async t => {
  const f = await fixture(t, undefined, { runtimeProfile: 'jar1' });
  const root = path.join(f.home, '.iia');
  const files = await Promise.all([
    writeMutes(path.join(root, 'monitor'), mutes('balance', 'pause_reminder')),
    writeMutes(path.join(root, 'bots/default'), mutes('provider_credits', 'unknown')),
    writeMutes(path.join(root, 'bots/second'), mutes('pause_reminder')),
  ]);
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /Предупреждение о балансе мониторинга/);
  assert.match(f.edits.at(-1), /кончились деньги у провайдера/u);
  assert.doesNotMatch(f.edits.at(-1), /пауза автономки|unknown/i);
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard.flat().map(button => button.callback_data), ['settings:back']);
  await f.callback('settings:back');
  assert.match(f.edits.at(-1), /Настройки/);
  for (const { file, data } of files) assert.equal(await fs.readFile(file, 'utf8'), data);
});

test('notification settings use the parent of the configured sessions directory', async t => {
  const f = await fixture(t, undefined, { runtimeProfile: 'jar1' });
  const dir = path.join(f.home, 'custom-bot');
  delete process.env.MSB_SESSION_DIR;
  process.env.IIA_SESSION_DIR = path.join(dir, 'sessions');
  await writeMutes(dir, mutes('pause_reminder'));
  await writeMutes(path.join(f.home, '.iia/bots/default'), mutes('provider_credits'));
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /Напоминание о паузе автономки/);
  assert.doesNotMatch(f.edits.at(-1), /кончились деньги у провайдера/);
});

test('notification settings read a legacy single-bot file only for the default jar1 profile', async t => {
  const f = await fixture(t, undefined, { runtimeProfile: 'jar1' });
  delete process.env.MSB_SESSION_DIR;
  delete process.env.IIA_SESSION_DIR;
  await writeMutes(path.join(f.home, '.iia'), mutes('pause_reminder'));
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /Напоминание о паузе автономки/);

  process.env.MSB_BOT_ID = 'second';
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /Ничего не отключено/);
  assert.doesNotMatch(f.edits.at(-1), /пауза автономки/i);
});

test('notification settings distinguish missing data from unreadable preferences', async t => {
  const f = await fixture(t);
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /Ничего не отключено/);
  const { file, data } = await writeMutes(path.join(f.home, '.msb/monitor'), '{broken');
  await f.callback('nm:list');
  assert.match(f.edits.at(-1), /не удалось прочитать/iu);
  assert.doesNotMatch(f.edits.at(-1), /Ничего не отключено/);
  assert.equal(await fs.readFile(file, 'utf8'), data);
});
