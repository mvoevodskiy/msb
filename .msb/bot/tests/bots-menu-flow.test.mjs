/** New-bot input and cancellation through the real menu, with a fake status-only bot-ctl. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './helpers/menu-fixture.mjs';

test('new bot form shows only Cancel and ordinary messages resume after cancellation', async t => {
  const prompts = [];
  const f = await fixture(t, async ({ prompt }) => {
    prompts.push(prompt);
    return { ok: true, text: 'fixture reply' };
  });
  const bin = path.join(f.home, 'bin');
  const sudoLog = path.join(f.home, 'sudo.log');
  const statusArgs = '-n /usr/local/bin/bot-ctl.sh is-active default';
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'sudo'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$MSB_BOTS_FIXTURE_SUDO_LOG"',
    `[ "$*" = '${statusArgs}' ] || exit 64`,
    'printf "active\\n"',
    '',
  ].join('\n'), { mode: 0o700 });
  process.env.MSB_BOTS_FIXTURE_SUDO_LOG = sudoLog;
  process.env.PATH = [bin, process.env.PATH].join(path.delimiter);
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    fetchCalls++;
    throw Error('Unexpected network request');
  });

  const buttons = () => f.editOptions.at(-1).reply_markup.inline_keyboard.flat();
  await f.callback('settings:bots');
  assert.match(f.edits.at(-1), /Мои боты/);
  const add = buttons().find(button => button.callback_data === 'settings:bots:add');
  assert.ok(add);
  await f.callback(add.callback_data);
  assert.match(f.edits.at(-1), /Новый бот/);
  assert.deepEqual(buttons(), [{ text: '✖ Отмена', callback_data: 'settings:bots:cancel' }]);

  await f.callback(buttons()[0].callback_data);
  assert.match(f.edits.at(-1), /Мои боты/);
  await f.message('ordinary task');
  for (let retries = 0; prompts.length === 0 && retries < 100; retries++) await delay(10);
  assert.deepEqual(prompts, ['ordinary task']);
  assert.equal(fetchCalls, 0);
  assert.equal(await fs.readFile(sudoLog, 'utf8'), `${statusArgs}\n${statusArgs}\n`);
});
