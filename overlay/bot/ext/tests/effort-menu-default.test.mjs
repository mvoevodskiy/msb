import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setActive, setSelectedEffort } from '../store.mjs';
import { buildEffortMenu } from '../menu.mjs';

test('Codex effort menu shows explicit settings without inventing a universal default', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-effort-menu-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { MSB_BOT_ID: 'default' };
  const config = path.join(home, '.codex/config.toml');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await setActive('codex', env, home);
  await fs.writeFile(config, 'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "xhigh"\n');
  let menu = await buildEffortMenu(env, home);
  assert.doesNotMatch(menu.text, /high<\/b>: углублённо \(по умолчанию\)/);
  assert.match(menu.text, /Сейчас:<\/b> xhigh/);
  assert.ok(menu.keyboard.inline_keyboard.flat().some(b => b.text === 'xhigh ✓'));
  assert.ok(menu.keyboard.inline_keyboard.flat().some(b => b.callback_data === 'ext:effort:set:max'));

  await fs.writeFile(config, 'model = "gpt-6.1-terra"\n');
  const before = await fs.readFile(config, 'utf8');
  menu = await buildEffortMenu(env, home);
  assert.match(menu.text, /Сейчас:<\/b> по умолчанию CLI/);
  assert.equal(menu.keyboard.inline_keyboard.flat().some(b => / ✓$/.test(b.text)), false);
  assert.equal(await fs.readFile(config, 'utf8'), before);

  await setSelectedEffort('codex', 'medium', env, home);
  menu = await buildEffortMenu(env, home);
  assert.match(menu.text, /Сейчас:<\/b> medium/);
  assert.ok(menu.keyboard.inline_keyboard.flat().some(b => b.text === 'medium ✓'));
});
