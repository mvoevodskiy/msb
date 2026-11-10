import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setActive } from '../store.mjs';
import { writeEnvKey } from '../env.mjs';
import { buildConnMenu, buildModelMenu, buildAgentMenu, buildEffortMenu, authPrompt } from '../menu.mjs';

test('buildConnMenu marks active provider and lists all four', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-'));
  const env = { MSB_BOT_ID: 'default' };
  await setActive('codex', env, home);
  await writeEnvKey('CODEX_ACCESS_TOKEN', 'codex-token-1234567890', env, home);

  const menu = await buildConnMenu(env, home);
  assert.match(menu.text, /Codex/);
  const flat = menu.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(flat.includes('ext:conn:set:claude'));
  assert.ok(flat.includes('ext:conn:set:cursor'));
  assert.ok(flat.includes('ext:conn:set:codex'));
  assert.ok(flat.includes('ext:conn:set:qwen'));
  assert.ok(flat.some((d) => d === 'ext:auth:cursor'));
  assert.ok(flat.includes('settings:auth:switch-sub'));
  assert.ok(flat.includes('settings:auth:openrouter'), 'штатный OpenRouter');
  assert.ok(flat.includes('settings:engine:set:oc'), 'штатный OpenClaw');
  assert.ok(flat.includes('settings:engine:set:cc'), 'штатный движок Claude');
  assert.ok(flat.includes('menu:settings'), 'Назад из подключений → настройки');
  assert.ok(!flat.includes('menu:agent'), 'Назад не должен вести в Агент/Модель');
});

test('authPrompt for cursor', () => {
  const prompt = authPrompt('cursor');
  assert.match(prompt.text, /Cursor/);
  assert.equal(prompt.keyboard.inline_keyboard[0][0].callback_data, 'settings:auth');
});

test('authPrompt for codex is native login, not secret paste', () => {
  const prompt = authPrompt('codex');
  assert.equal(prompt.nativeLogin, true);
  assert.match(prompt.text, /Секрет в Telegram не присылай/);
  assert.doesNotMatch(prompt.text, /Пришли ключ одним сообщением/);
});

test('buildModelMenu for codex talks about Codex, not Claude', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-'));
  const env = { MSB_BOT_ID: 'default' };
  await setActive('codex', env, home);
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.codex', 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 't', refresh_token: 'r' } }),
    { mode: 0o600 },
  );

  const menu = await buildModelMenu(env, home);
  assert.ok(menu);
  assert.match(menu.text, /Codex/);
  assert.doesNotMatch(menu.text, /Claude Opus|Anthropic|семейств/);
  const flat = menu.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(flat.some((d) => d.startsWith('ext:model:set:')));
  assert.ok(flat.includes('menu:agent'));
});

test('buildAgentMenu and effort show Codex provider/model, not Claude', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-'));
  const env = { MSB_BOT_ID: 'default' };
  await setActive('codex', env, home);
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.codex', 'config.toml'),
    'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n',
  );

  const agent = await buildAgentMenu(env, home);
  assert.ok(agent);
  assert.match(agent.text, /Codex/);
  assert.match(agent.text, /gpt-6\.1-sol|GPT-6\.1 Sol/);
  assert.doesNotMatch(agent.text, /Claude Code|Anthropic|Opus 5|Sonnet 4/);
  assert.ok(agent.keyboard.inline_keyboard.flat().some((b) => b.callback_data === 'settings:model'));

  const effort = await buildEffortMenu(env, home);
  assert.match(effort.text, /Codex/);
  assert.doesNotMatch(effort.text, /Claude Code|Anthropic/);
});

test('buildAgentMenu returns null for claude (штатный экран)', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-'));
  const env = { MSB_BOT_ID: 'default' };
  await setActive('claude', env, home);
  assert.equal(await buildAgentMenu(env, home), null);
});

test('Codex MAX is offered and permissions describe the actual fixed mode', async (t) => {
  const { buildPermModeMenu } = await import('../menu.mjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-ui-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { MSB_BOT_ID: 'default' };
  await setActive('codex', env, home);
  const effort = await buildEffortMenu(env, home);
  assert.ok(effort.keyboard.inline_keyboard.flat().some((b) => b.callback_data === 'ext:effort:set:max'));
  const perms = await buildPermModeMenu(env, home);
  assert.match(perms.text, /полный доступ, без подтверждений/i);
  assert.ok(perms.keyboard.inline_keyboard.flat().some((b) => b.callback_data === 'ext:permmode:set:control'));
  const conn = await buildConnMenu(env, home);
  assert.match(conn.text, /Сейчас отвечает: <b>Codex/);
  assert.doesNotMatch(conn.text, /Штатный движок бандла/);
});
