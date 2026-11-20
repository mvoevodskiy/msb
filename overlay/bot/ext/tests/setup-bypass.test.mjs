import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setActive, storePath } from '../store.mjs';
import { writeEnvKey } from '../env.mjs';
import { syncExtAuthGate, EXT_AUTH_FLAG } from '../setup-bypass.mjs';
import { botStatePath } from '../paths.mjs';

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'msb-ext-bypass-'));
}

async function readState(env, home) {
  return JSON.parse(await fs.readFile(botStatePath(env, home), 'utf8'));
}

test('setup-bypass: cursor key sets subscription authMode', async () => {
  const home = await tmpHome();
  const env = { MSB_BOT_ID: 'default' };
  await writeEnvKey('CURSOR_API_KEY', 'cursor-test-key-xxxxxxxx', env, home);
  await setActive('cursor', env, home);

  const r = await syncExtAuthGate(env, home);
  assert.equal(r.changed, true);
  const st = await readState(env, home);
  assert.equal(st.authMode, 'subscription');
  assert.equal(st.hasSubscriptionAuth, true);
  assert.equal(st[EXT_AUTH_FLAG], 'cursor');
});

test('setup-bypass: switch to bare claude clears bypass', async () => {
  const home = await tmpHome();
  const env = { MSB_BOT_ID: 'default' };
  await writeEnvKey('CURSOR_API_KEY', 'cursor-test-key-xxxxxxxx', env, home);
  await setActive('cursor', env, home);
  await syncExtAuthGate(env, home);

  await setActive('claude', env, home);
  const r = await syncExtAuthGate(env, home);
  assert.equal(r.changed, true);
  const st = await readState(env, home);
  assert.equal(st.authMode, undefined);
  assert.equal(st[EXT_AUTH_FLAG], undefined);
});

test('setup-bypass: leaving codex drops foreign ext ccSessionId', async () => {
  const home = await tmpHome();
  const env = { MSB_BOT_ID: 'default' };
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.codex', 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 't', refresh_token: 'r' } }),
    { mode: 0o600 },
  );
  await setActive('codex', env, home);
  await syncExtAuthGate(env, home);
  const stateFile = botStatePath(env, home);
  const st0 = await readState(env, home);
  st0.ccSessionId = 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
  await fs.writeFile(stateFile, `${JSON.stringify(st0, null, 2)}\n`);

  await setActive('claude', env, home);
  const r = await syncExtAuthGate(env, home);
  assert.equal(r.changed, true);
  const st = await readState(env, home);
  assert.equal(st.ccSessionId, undefined);
  assert.equal(st[EXT_AUTH_FLAG], undefined);
});

test('setup-bypass: noop on OpenClaw engine', async () => {
  const home = await tmpHome();
  const env = { MSB_BOT_ID: 'default' };
  await fs.mkdir(path.dirname(botStatePath(env, home)), { recursive: true });
  await fs.writeFile(
    botStatePath(env, home),
    JSON.stringify({ engine: 'oc', authMode: 'api-key' }, null, 2),
  );
  await writeEnvKey('CURSOR_API_KEY', 'cursor-test-key-xxxxxxxx', env, home);
  await setActive('cursor', env, home);

  const r = await syncExtAuthGate(env, home);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'oc-engine');
});


test('setup-bypass: a completed Codex login cannot select after the relative profile changed', async (t) => {
  const home = await tmpHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, 'workspace');
  const env = { HOME: home, MSB_BOT_ID: 'default', MSB_WORKSPACE_DIR: workspace, CODEX_HOME: 'native-profile' };
  const alpha = path.join(home, 'projects', 'alpha', 'native-profile');
  const beta = path.join(home, 'projects', 'beta', 'native-profile');
  for (const directory of [alpha, beta]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'auth.json'), '{"auth_mode":"chatgpt"}');
  }
  await setActive('claude', env, home);
  const file = botStatePath(env, home);
  const state = { engine: 'cc', authMode: 'subscription', hasSubscriptionAuth: true,
    activeProject: 'beta', ccSessionId: 'fixture-claude-session' };
  await fs.writeFile(file, JSON.stringify(state));
  const before = await fs.readFile(storePath(env, home), 'utf8');
  const stale = await syncExtAuthGate(env, home, { activateCli: true, verifiedCodexProfile: alpha });
  assert.equal(stale.reason, 'codex-profile-not-ready');
  assert.equal(await fs.readFile(storePath(env, home), 'utf8'), before);
  assert.deepEqual(await readState(env, home), state);

  const current = await syncExtAuthGate(env, home, { activateCli: true, verifiedCodexProfile: beta });
  assert.equal(current.selected, true);
  assert.equal((await readState(env, home))[EXT_AUTH_FLAG], 'codex');
});
