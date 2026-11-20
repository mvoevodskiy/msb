import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodexTurn } from '../adapters/codex.mjs';
import { compactCodex } from '../compact-codex.mjs';
import { buildAgentMenu, buildEffortMenu, buildModelMenu } from '../menu.mjs';
import { applyProviderModel, applyProviderEffort } from '../apply-model.mjs';
import { botStatePath } from '../paths.mjs';
import { loadStore, setActive, setSession, setSelectedEffort, setSelectedModel } from '../store.mjs';

const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const ccSessionId = 'ext:codex:' + thread;
const nativeAuth = '{"tokens":{"access_token":"fixture"}}\n';
const inactiveConfig = 'model = "gpt-5.4"\nmodel_reasoning_effort = "low"\n';
const activeConfig = [
  '  model = "gpt-5.4-mini" # native default',
  "model_reasoning_effort = 'high' # root setting",
  'model_provider = "fixture" # keep this provider',
  'stream_idle_timeout_ms = 600000',
  '[model_providers.fixture]',
  'name = "fixture"',
  '',
].join('\n');

async function fixture(t, mode) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-codex-profile-prefs-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'projects', 'alpha');
  const profile = path.join(cwd, 'native-profile');
  const inactive = path.join(home, '.codex');
  const bin = path.join(home, 'bin');
  const env = { HOME: home, MSB_BOT_ID: 'default', MSB_WORKSPACE_DIR: path.join(home, 'workspace'),
    PATH: bin, CODEX_HOME: mode === 'relative' ? 'native-profile' : profile };
  for (const dir of [bin, inactive, profile, env.MSB_WORKSPACE_DIR]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(inactive, 'config.toml'), inactiveConfig);
  await fs.writeFile(path.join(inactive, 'auth.json'), nativeAuth);
  await fs.writeFile(path.join(inactive, 'models_cache.json'), '{"models":[{"slug":"inactive-model"}]}');
  await fs.writeFile(path.join(profile, 'config.toml'), activeConfig);
  await fs.writeFile(path.join(profile, 'auth.json'), nativeAuth);
  await fs.writeFile(path.join(profile, 'models_cache.json'), '{"models":[{"slug":"selected-model"}]}');
  await setActive('codex', env, home);
  await setSession('codex', thread, env, home);
  await fs.writeFile(botStatePath(env, home), JSON.stringify({ activeProject: 'alpha', ccSessionId }));
  return { home, env, cwd, bin, profile, inactive };
}

for (const mode of ['absolute', 'relative']) {
  test('Codex turn and compact use the ' + mode + ' selected profile', async (t) => {
    const { home, env, cwd, bin, profile, inactive } = await fixture(t, mode);
    const call = path.join(home, 'call.json');
    const program = '#!' + process.execPath + '\n' + [
      'const fs = require("node:fs");',
      'fs.writeFileSync(' + JSON.stringify(call) + ', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));',
      'process.stdin.resume();',
      'process.stdin.once("end", () => {',
      '  console.log(JSON.stringify({type:"thread.started", thread_id:' + JSON.stringify(thread) + '}));',
      '  console.log(JSON.stringify({type:"item.completed", item:{type:"agent_message", text:"fixture reply"}}));',
      '  console.log(JSON.stringify({type:"turn.completed"}));',
      '});',
    ].join('\n');
    await fs.writeFile(path.join(bin, 'codex'), program, { mode: 0o755 });
    const run = parsed => runCodexTurn({ prompt: 'fixture', cwd, parsed, env, home });
    assert.equal((await run({ model: 'opus' })).model, 'gpt-5.4-mini');
    const first = JSON.parse(await fs.readFile(call, 'utf8'));
    assert.equal(await fs.realpath(first.cwd), await fs.realpath(cwd));
    assert.ok(first.args.includes('gpt-5.4-mini'));
    assert.ok(first.args.includes('model_reasoning_effort="high"'));
    assert.equal(first.args.some(arg => arg.startsWith('model_provider=')), false);
    assert.equal(await fs.readFile(path.join(inactive, 'config.toml'), 'utf8'), inactiveConfig);
    assert.equal(await fs.readFile(path.join(profile, 'config.toml'), 'utf8'), activeConfig);

    // Only the selected profile is authenticated for the resumed and compacted turn.
    await fs.unlink(path.join(inactive, 'auth.json'));
    await setSelectedModel('codex', 'gpt-6.1-terra', env, home);
    await setSelectedEffort('codex', 'max', env, home);
    const continued = await run({ resume: ccSessionId, model: 'opus' });
    assert.equal(continued.model, 'gpt-6.1-terra');
    assert.equal(continued.nativeSessionId, thread);
    const { args } = JSON.parse(await fs.readFile(call, 'utf8'));
    assert.equal(args[args.indexOf('resume') + 1], thread);
    assert.ok(args.includes('model_reasoning_effort="max"'));

    const compacted = await compactCodex({ ccSessionId }, { env, cwd, run: (options) => {
      assert.equal(options.cwd, cwd);
      assert.equal(options.threadId, thread);
      assert.equal(options.model, 'gpt-6.1-terra');
      assert.equal(options.effort, 'max');
      return { ok: true };
    } });
    assert.deepEqual(compacted, { ok: true });
    assert.equal(await fs.readFile(path.join(profile, 'auth.json'), 'utf8'), nativeAuth);
  });

  test('Codex menus read and update only the ' + mode + ' selected profile', async (t) => {
    const { home, env, profile, inactive } = await fixture(t, mode);
    const model = await buildModelMenu(env, home);
    assert.equal(model.current, 'gpt-5.4-mini');
    assert.ok(model.models.some(entry => entry.id === 'selected-model'));
    assert.equal(model.models.some(entry => entry.id === 'inactive-model'), false);
    assert.equal((await buildEffortMenu(env, home)).current, 'high');
    assert.equal((await buildAgentMenu(env, home)).modelId, 'gpt-5.4-mini');

    assert.deepEqual(await applyProviderModel('codex', 'gpt-6.1-terra', env, home), { ok: true });
    assert.deepEqual(await applyProviderEffort('codex', 'max', env, home), { ok: true });
    const text = await fs.readFile(path.join(profile, 'config.toml'), 'utf8');
    assert.match(text, /^model = "gpt-6.1-terra"$/m);
    assert.match(text, /^model_reasoning_effort = "max"$/m);
    assert.ok(text.endsWith('[model_providers.fixture]\nname = "fixture"\n'));
    assert.equal(await fs.readFile(path.join(inactive, 'config.toml'), 'utf8'), inactiveConfig);
    const store = await loadStore(env, home);
    assert.deepEqual(store.models, { codex: 'gpt-6.1-terra' });
    assert.deepEqual(store.efforts, { codex: 'max' });
    assert.deepEqual(store.sessions, { codex: thread });
    assert.equal((await buildModelMenu(env, home)).current, 'gpt-6.1-terra');
    assert.equal((await buildEffortMenu(env, home)).current, 'max');
  });
}

test('missing selected project cannot redirect a relative Codex preference write', async (t) => {
  const { home, env, cwd, inactive } = await fixture(t, 'relative');
  await fs.rename(cwd, cwd + '-removed');
  const before = await loadStore(env, home);
  assert.equal((await applyProviderModel('codex', 'gpt-6.1-terra', env, home)).ok, false);
  assert.equal((await applyProviderEffort('codex', 'max', env, home)).ok, false);
  assert.deepEqual(await loadStore(env, home), before);
  assert.equal(await fs.readFile(path.join(inactive, 'config.toml'), 'utf8'), inactiveConfig);
});
