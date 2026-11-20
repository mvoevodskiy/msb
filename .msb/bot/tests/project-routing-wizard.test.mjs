/** Routing wizard save/home + agent prompt; synthetic HOME, no live CLI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  defaultRoutingDraft,
  formatRoutingSettingsYaml,
  saveProjectRouting,
  deleteProjectRouting,
  loadProjectRouting,
} from '../src/projects/routing.mjs';
import { parseRoutingSettingsText } from '../src/projects/routing-parse.mjs';
import { normalizeRoutingSettings } from '../src/projects/routing-schema.mjs';
import { routingCapabilityPrompt, routingAgentManual } from '../src/projects/routing-prompt.mjs';
import { buildSystemPrompt } from '../src/agent/system-prompt.mjs';
import { routingSettingsHome, routingWizardConfirmScreen } from '../src/telegram/screens/routing-wizard.mjs';
import { settingsScreen } from '../src/telegram/screens/settings.mjs';

async function tree(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-routing-wiz-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, 'workspace');
  const project = path.join(home, 'projects', 'alpha');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  return {
    home, workspace, project,
    env: { HOME: home, MSB_WORKSPACE_DIR: workspace, MSB_RUNTIME_ROOT: path.join(home, '.msb') },
  };
}

test('routing save: yaml round-trips through parser/schema', async t => {
  const f = await tree(t);
  const draft = defaultRoutingDraft(['claude', 'codex', 'cursor']);
  const saved = await saveProjectRouting(f.project, draft);
  assert.match(saved.path, /\.msb\/settings\.yaml$/);
  const loaded = await loadProjectRouting(f.project);
  assert.equal(loaded.settings.routing.types.make.provider, 'codex');
  assert.equal(loaded.settings.routing.types.ask.model, 'sonnet');
  const again = normalizeRoutingSettings(parseRoutingSettingsText(formatRoutingSettingsYaml(loaded.settings)));
  assert.equal(again.routing.default, 'ask');
});

test('routing save: delete turns routing off', async t => {
  const f = await tree(t);
  await saveProjectRouting(f.workspace, defaultRoutingDraft(['claude']));
  assert.ok(await loadProjectRouting(f.workspace));
  assert.equal(await deleteProjectRouting(f.workspace), true);
  assert.equal(await loadProjectRouting(f.workspace), null);
});

test('routing wizard screens: settings entry and confirm mention file path', () => {
  const settings = settingsScreen({});
  assert.ok(settings.keyboard.inline_keyboard.flat().some(b => b.callback_data === 'settings:routing'));
  const home = routingSettingsHome({ cwd: '/tmp/ws', loaded: null });
  assert.match(home.text, /Мастер/);
  assert.ok(home.keyboard.inline_keyboard.flat().some(b => b.callback_data === 'settings:routing:wiz'));
  const confirm = routingWizardConfirmScreen(defaultRoutingDraft(['claude']).routing, '/tmp/ws');
  assert.match(confirm.text, /\.msb\/settings\.yaml/);
  assert.ok(confirm.keyboard.inline_keyboard.flat().some(b => b.callback_data === 'settings:routing:wiz:save'));
});

test('routing agent prompt: manual + live status in system prompt', async t => {
  const f = await tree(t);
  assert.match(routingAgentManual(), /\.msb\/settings\.yaml/);
  assert.match(routingAgentManual(), /мастер/i);
  await fs.writeFile(path.join(f.workspace, 'SOUL.md'), 'owner-soul');
  const off = await routingCapabilityPrompt({ cwd: f.workspace, env: f.env });
  assert.match(off, /отсутствует/);
  await saveProjectRouting(f.workspace, defaultRoutingDraft(['claude']));
  const on = await buildSystemPrompt({ env: f.env, workspace: f.workspace, cwd: f.workspace });
  assert.match(on, /Маршрутизация режимов задачи/);
  assert.match(on, /ask: claude/);
  assert.match(on, /settings\.yaml/);
});
