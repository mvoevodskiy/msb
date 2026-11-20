import fs from 'node:fs/promises';
import path from 'node:path';
import { buildSystemPrompt } from '../src/agent/system-prompt.mjs';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { autonomyHistoryScreen, updatesScreen } from '../src/telegram/screens.mjs';
import { buildLocalSshMenu, localSshPrompt } from '../../../overlay/bot/ext/menu.mjs';

test('runtime profile preserves existing JAR1 variable names, paths and LAN examples in UI', async t => {
  const previous = { ...process.env };
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-ui-'));
  process.env.AUTONOMY_DIR = path.join(workspace, 'autonomy');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in previous)) delete process.env[k]; Object.assign(process.env, previous); });
  for (const [id, prefix, example] of [['jar1', 'IIA_', '192.168.33.203'], ['msb', 'MSB_', '192.168.1.10']]) {
    process.env.MSB_RUNTIME_PROFILE = id;
    process.env.MSB_OWN_UPDATES_URL = '';
    assert.ok((await buildSystemPrompt({ workspace })).includes(`через ${prefix.slice(0, -1)} open-core.`));
    const history = await autonomyHistoryScreen();
    assert.match(history.text, /Прогонов в журнале пока нет/);
    assert.equal(history.keyboard.inline_keyboard[0][0].callback_data, 'auto:home');
    assert.ok((await updatesScreen()).text.includes(`${prefix}OWN_UPDATES_URL`));
    const env = { MSB_RUNTIME_PROFILE: id };
    const menu = await buildLocalSshMenu(env);
    assert.ok(menu.text.includes(`${prefix}LOCAL_SSH_HOST`));
    assert.ok(menu.text.includes(example));
    assert.ok(localSshPrompt(env).text.includes(example));
  }
});
