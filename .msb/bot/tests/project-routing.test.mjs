/** Project routing settings: parse/schema/resolve/load; no live CLI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseRoutingSettingsText } from '../src/projects/routing-parse.mjs';
import { normalizeRoutingSettings } from '../src/projects/routing-schema.mjs';
import { loadProjectRouting } from '../src/projects/routing-load.mjs';
import { resolveTaskMode, normalizeModeToken } from '../src/projects/routing-resolve.mjs';
import { validateRoute } from '../src/projects/routing-validate.mjs';
import { prepareProjectRouting, setForcedRoutingMode, applyRoutingModeState } from '../src/projects/routing-prepare.mjs';
import { applyProjectSelection } from '../src/projects/selection.mjs';
import { ROUTING_MODES } from '../src/projects/routing-modes.mjs';
import { saveProjectRouting, setProjectRoutingEnabled } from '../src/projects/routing-save.mjs';
import { defaultRoutingDraft } from '../src/projects/routing-save.mjs';
import { isRoutingEnabled } from '../src/projects/routing-schema.mjs';

const SAMPLE_YAML = `
version: 1
routing:
  default: ask
  apply: sticky
  types:
    ask:
      provider: claude
      model: sonnet
      effort: medium
    make:
      provider: codex
      model: null
      effort: high
    study:
      provider: claude
      model: opus
      effort: high
    check:
      provider: claude
      model: opus
      effort: high
    run:
      provider: cursor
      model: null
      effort: null
  aliases:
    анализ: study
    дизайн: make
`;

function sampleRouting() {
  return normalizeRoutingSettings(parseRoutingSettingsText(SAMPLE_YAML)).routing;
}

async function projectTree(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-routing-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, 'workspace');
  const project = path.join(home, 'projects', 'alpha');
  await fs.mkdir(path.join(project, '.msb'), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  const env = { HOME: home, MSB_WORKSPACE_DIR: workspace, MSB_RUNTIME_ROOT: path.join(home, '.msb') };
  return { home, workspace, project, env };
}

test('routing parse: YAML sample normalizes with default aliases and modes', () => {
  const settings = normalizeRoutingSettings(parseRoutingSettingsText(SAMPLE_YAML));
  assert.equal(settings.version, 1);
  assert.equal(settings.routing.default, 'ask');
  assert.equal(settings.routing.types.make.provider, 'codex');
  assert.equal(settings.routing.types.make.model, null);
  assert.equal(settings.routing.aliases['анализ'], 'study');
  assert.equal(settings.routing.aliases.дизайн, 'make');
  assert.equal(settings.routing.aliases.ask, 'ask');
  assert.equal(normalizeModeToken('Анализ', settings.routing.aliases), 'study');
});

test('routing parse: JSON settings accepted', () => {
  const settings = normalizeRoutingSettings(parseRoutingSettingsText(JSON.stringify({
    version: 1,
    routing: {
      default: 'ask',
      types: Object.fromEntries(ROUTING_MODES.map(mode => [mode, { provider: 'claude', model: null, effort: null }])),
    },
  })));
  assert.equal(settings.routing.types.check.provider, 'claude');
});

test('routing schema: missing mode and unknown mode fail', () => {
  assert.throws(() => normalizeRoutingSettings({ version: 1, routing: { default: 'ask', types: { ask: { provider: 'claude' } } } }), /не хватает/);
  const full = Object.fromEntries(ROUTING_MODES.map(mode => [mode, { provider: 'claude' }]));
  full.extra = { provider: 'claude' };
  assert.throws(() => normalizeRoutingSettings({ version: 1, routing: { default: 'ask', types: full } }), /неизвестные режимы/);
});

test('routing parse: broken YAML fails closed', () => {
  assert.throws(() => parseRoutingSettingsText('version 1\nbad'), /ключ:значение|ROUTING_PARSE/);
});

test('routing resolve: prefix alias overrides sticky without rewriting it', () => {
  const routing = sampleRouting();
  const resolved = resolveTaskMode({
    text: '#анализ проверь метрики',
    stickyMode: 'make',
    routing,
  });
  assert.equal(resolved.mode, 'study');
  assert.equal(resolved.prompt, 'проверь метрики');
  assert.equal(resolved.source, 'prefix');
  assert.equal(resolved.stickyNext, 'make');
});

test('routing resolve: unknown prefix errors', () => {
  const resolved = resolveTaskMode({ text: '#xyz задача', routing: sampleRouting() });
  assert.equal(resolved.source, 'prefix-invalid');
  assert.match(resolved.error, /неизвестный режим/);
});

test('routing resolve: once mode consumes one-shot', () => {
  const routing = { ...sampleRouting(), apply: 'once' };
  const resolved = resolveTaskMode({ text: 'сделай', onceMode: 'make', routing });
  assert.equal(resolved.mode, 'make');
  assert.equal(resolved.source, 'once');
  assert.equal(resolved.clearOnce, true);
});

test('routing validate: unavailable provider and bad Claude model', async () => {
  await assert.rejects(() => validateRoute({ provider: 'codex' }, { availableProviders: ['claude'] }), /недоступен/);
  await assert.rejects(() => validateRoute({ provider: 'claude', model: 'nope-model' }, { availableProviders: ['claude'] }), /неизвестная модель/);
  await validateRoute({ provider: 'claude', model: 'sonnet', effort: 'medium' }, { availableProviders: ['claude'] });
});

test('routing load: missing file is off; valid yaml loads; escape symlink rejected', async t => {
  const f = await projectTree(t);
  assert.equal(await loadProjectRouting(f.project), null);
  await fs.writeFile(path.join(f.project, '.msb', 'settings.yaml'), SAMPLE_YAML);
  const loaded = await loadProjectRouting(f.project);
  assert.equal(loaded.settings.routing.types.study.model, 'opus');

  const outside = path.join(f.home, 'outside.yaml');
  await fs.writeFile(outside, SAMPLE_YAML);
  await fs.rm(path.join(f.project, '.msb', 'settings.yaml'));
  await fs.symlink(outside, path.join(f.project, '.msb', 'settings.yaml'));
  await assert.rejects(() => loadProjectRouting(f.project), /вне каталога|ROUTING_PATH/);
});

test('routing prepare: active project file + sticky state', async t => {
  const f = await projectTree(t);
  await fs.writeFile(path.join(f.project, '.msb', 'settings.yaml'), SAMPLE_YAML);
  const prepared = await prepareProjectRouting({
    state: { activeProject: 'alpha', projectTaskMode: 'check' },
    text: 'посмотри риски',
    env: f.env,
    availableProviders: ['claude', 'codex', 'cursor'],
  });
  assert.equal(prepared.active, true);
  assert.equal(prepared.mode, 'check');
  assert.equal(prepared.route.provider, 'claude');
  assert.equal(prepared.error, undefined);
});

test('routing prepare: unavailable provider surfaces error', async t => {
  const f = await projectTree(t);
  await fs.writeFile(path.join(f.project, '.msb', 'settings.yaml'), SAMPLE_YAML);
  const prepared = await prepareProjectRouting({
    state: { activeProject: 'alpha' },
    text: '#make feature',
    env: f.env,
    availableProviders: ['claude'],
  });
  assert.equal(prepared.mode, 'make');
  assert.match(prepared.error, /codex/);
});

test('routing state: project switch clears mode markers', () => {
  const state = applyProjectSelection({
    projectTaskMode: 'make',
    projectTaskModeOnce: 'study',
    ccSessionId: 'x',
    sessionEpoch: 1,
  }, undefined);
  assert.equal(state.projectTaskMode, undefined);
  assert.equal(state.projectTaskModeOnce, undefined);
});

test('routing state: forced sticky / once helpers', () => {
  const sticky = {};
  assert.equal(setForcedRoutingMode(sticky, 'make', 'sticky'), true);
  assert.equal(sticky.projectTaskMode, 'make');
  const once = { projectTaskMode: 'ask' };
  assert.equal(setForcedRoutingMode(once, 'study', 'once'), true);
  assert.equal(once.projectTaskModeOnce, 'study');
  const prepared = { active: true, clearOnce: true, stickyNext: 'ask', settings: { routing: { apply: 'sticky' } } };
  applyRoutingModeState(once, prepared);
  assert.equal(once.projectTaskModeOnce, undefined);
  assert.equal(once.projectTaskMode, 'ask');
});

test('routing enabled flag: false keeps file but prepare is inactive', async t => {
  const f = await projectTree(t);
  await saveProjectRouting(f.project, defaultRoutingDraft(['claude', 'codex']));
  await setProjectRoutingEnabled(f.project, false);
  const loaded = await loadProjectRouting(f.project);
  assert.equal(isRoutingEnabled(loaded.settings), false);
  const prepared = await prepareProjectRouting({
    state: { activeProject: 'alpha' },
    text: '#make feature',
    env: f.env,
    availableProviders: ['claude', 'codex'],
  });
  assert.equal(prepared.active, false);
  assert.equal(prepared.disabled, true);
  assert.equal(prepared.prompt, '#make feature');
});
