import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyProviderModel, applyProviderEffort } from '../apply-model.mjs';
import { ensureCodexStableTransport } from '../codex-transport.mjs';
import { parseCodexTomlScalars } from '../codex-native.mjs';
import { getSelectedModel, loadStore, setActive, setSelectedModel, setSession, storePath } from '../store.mjs';

test('applyProviderModel writes codex config.toml and store', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-model-'));
  const env = { MSB_BOT_ID: 'default' };
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex', 'config.toml'), 'approval_policy = "never"\n');

  const r = await applyProviderModel('codex', 'gpt-6.1-sol', env, home);
  assert.equal(r.ok, true);
  assert.equal(await getSelectedModel('codex', env, home), 'gpt-6.1-sol');
  const toml = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /model = "gpt-6.1-sol"/);
  assert.match(toml, /approval_policy = "never"/);
});

test('MAX is selectable, persists at TOML root and reaches new/resumed CLI calls', async (t) => {
  const { getSelectedEffort } = await import('../store.mjs');
  const { buildCodexExecArgs } = await import('../adapters/codex.mjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-max-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { MSB_BOT_ID: 'default' };
  const file = path.join(home, '.codex/config.toml');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const table = '[profiles.test]\nmodel_reasoning_effort = "low"\n';
  await fs.writeFile(file, 'approval_policy = "never"\n' + table);
  assert.equal((await applyProviderEffort('codex', 'max', env, home)).ok, true);
  assert.equal(await getSelectedEffort('codex', env, home), 'max');
  const config = await fs.readFile(file, 'utf8');
  assert.match(config.split('[profiles.test]')[0], /model_reasoning_effort = "max"/);
  assert.ok(config.endsWith(table));
  for (const resumeId of [undefined, '0199a213-81c0-7800-8aa1-bbab2a035a53']) {
    const args = buildCodexExecArgs({ model: 'gpt-6.1-terra', effort: await getSelectedEffort('codex', env, home), resumeId });
    assert.ok(args.includes('model_reasoning_effort="max"'));
    assert.ok(args.includes('approval_policy="never"'));
  }
});


async function settingsFixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-codex-settings-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home, MSB_BOT_ID: 'default' };
  const file = path.join(home, '.codex/config.toml');
  const config = 'model = "gpt-5.4-mini"\nmodel_reasoning_effort = "high"\n\n[mcp_servers.fixture]\ncommand = "fixture"\n';
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, config, { mode: 0o640 });
  await setActive('codex', env, home);
  await setSession('codex', 'fixture-codex-session', env, home);
  await setSelectedModel('claude', 'opus', env, home);
  return { home, env, file, config, store: storePath(env, home) };
}

function failNextRename(t, filename) {
  const rename = fs.rename;
  let attempts = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to) === filename && ++attempts === 1) {
      throw Object.assign(new Error('fixture cannot publish ' + filename), { code: 'EACCES' });
    }
    return rename(from, to);
  });
  return () => attempts;
}

for (const [field, apply, value, savedField, key] of [
  ['model', applyProviderModel, 'gpt-6.1-terra', 'models', 'model'],
  ['effort', applyProviderEffort, 'max', 'efforts', 'model_reasoning_effort'],
]) {
  for (const filename of ['config.toml', 'ext-providers.json']) {
    test('failed ' + filename + ' publication keeps previous Codex ' + field + ' until retry', async (t) => {
      const { home, env, file, config, store } = await settingsFixture(t);
      const initialStore = await fs.readFile(store, 'utf8');
      const attempts = failNextRename(t, filename);
      const result = await apply('codex', value, env, home);
      assert.equal(result.ok, false);
      assert.match(result.error, /fixture cannot publish/);
      assert.equal(attempts(), 1);
      assert.equal(await fs.readFile(store, 'utf8'), initialStore);
      assert.equal(await fs.readFile(file, 'utf8'), config);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o640);

      assert.deepEqual(await apply('codex', value, env, home), { ok: true });
      assert.equal((await loadStore(env, home))[savedField].codex, value);
      assert.equal(parseCodexTomlScalars(await fs.readFile(file, 'utf8'))[key], value);
    });
  }
}

test('failed store publication does not create a native config on a fresh Codex profile', async (t) => {
  const { home, env, file, store } = await settingsFixture(t);
  await fs.unlink(file);
  const initialStore = await fs.readFile(store, 'utf8');
  failNextRename(t, 'ext-providers.json');
  assert.equal((await applyProviderEffort('codex', 'max', env, home)).ok, false);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal(await fs.readFile(store, 'utf8'), initialStore);
});

test('a shared Codex profile keeps concurrent preference, transport and session writes', async (t) => {
  const { home, env, file } = await settingsFixture(t);
  const alias = path.join(home, 'native-alias');
  await fs.symlink(path.dirname(file), alias, 'dir');
  const sibling = { ...env, MSB_BOT_ID: 'second', CODEX_HOME: alias };
  await setActive('codex', sibling, home);
  const [model, effort, transport] = await Promise.all([
    applyProviderModel('codex', 'gpt-6.1-terra', env, home),
    applyProviderEffort('codex', 'max', sibling, home),
    ensureCodexStableTransport(home, env),
    setSession('codex', 'later-codex-session', env, home),
  ]);
  assert.deepEqual(model, { ok: true });
  assert.deepEqual(effort, { ok: true });
  assert.equal(transport.ok, true);
  const native = await fs.readFile(file, 'utf8');
  const values = parseCodexTomlScalars(native);
  assert.equal(values.model, 'gpt-6.1-terra');
  assert.equal(values.model_reasoning_effort, 'max');
  assert.equal(values.model_provider, 'msb_http');
  assert.match(native, /\[mcp_servers\.fixture\]\ncommand = "fixture"\n/);
  const [first, second] = await Promise.all([loadStore(env, home), loadStore(sibling, home)]);
  assert.deepEqual(first.models, { claude: 'opus', codex: 'gpt-6.1-terra' });
  assert.deepEqual(first.efforts, {});
  assert.deepEqual(first.sessions, { codex: 'later-codex-session' });
  assert.deepEqual(second.models, {});
  assert.deepEqual(second.efforts, { codex: 'max' });
});
