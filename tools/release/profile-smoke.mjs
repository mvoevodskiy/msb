/** Exercise the actual exported JAR1 bytes in a disposable HOME; never start a bot. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const runtime = path.resolve(process.argv[2]);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jar1-release-profile-'));
const load = relative => import(pathToFileURL(path.join(runtime, relative)).href);
try {
  process.env.HOME = home;
  process.env.IIA_BOT_ID = 'default';
  process.env.IIA_WORKSPACE_DIR = path.join(home, 'workspace');
  delete process.env.MSB_BOT_ID;
  delete process.env.MSB_RUNTIME_PROFILE;
  delete process.env.MSB_OS_ENGINE;
  globalThis.fetch = () => { throw Error('Network forbidden in release smoke'); };
  await load('bot/shared/preload.mjs');
  const { default: profile } = await load('bot/shared/profile.cjs');
  const paths = await load('bot/src/paths.mjs');
  const extPaths = await load('bot/ext/paths.mjs');
  assert.equal(profile.resolveProfile().id, 'jar1');
  assert.equal(process.env.MSB_OS_ENGINE, 'legacy');
  assert.equal(paths.msbRoot(), path.join(home, '.iia'));
  assert.equal(extPaths.botStatePath(), paths.statePath());
  assert.equal(paths.workspaceDir(), path.join(home, 'workspace'));
  assert.equal(extPaths.botDir({ IIA_BOT_ID: 'other' }, path.join(home, 'second')),
    path.join(home, 'second/.iia/bots/other'));
  const bot = paths.botRoot();
  await fs.mkdir(bot, { recursive: true });
  await fs.writeFile(path.join(home, '.iia/.env'), 'DEEPGRAM_API_KEY=fixture-deepgram-not-a-real-key\n');
  const { resolveSttConfig } = await load('bot/src/media/stt.mjs');
  assert.equal((await resolveSttConfig()).apiKey, 'fixture-deepgram-not-a-real-key');
  const state = await load('bot/src/state.mjs');
  await state.saveState({ engine: 'cc', extAuthBypass: 'codex', ccSessionId: 'fixture-session' });
  await fs.writeFile(path.join(bot, 'ext-providers.json'), JSON.stringify({ active: 'codex', models: { codex: 'fixture-model' }, efforts: { codex: 'xhigh' } }));
  const { buildEngineProviderView } = await load('bot/ext/engine-menu.mjs');
  assert.equal((await buildEngineProviderView((await state.loadState()).state)).activeTitle, 'Codex');
  const { updateBotState } = await load('bot/ext/state-update.mjs');
  await Promise.all([state.updateState(s => ({ ...s, timezone: 'Europe/Moscow' })),
    updateBotState(s => ({ ...s, permissionMode: 'auto' }))]);
  assert.equal((await state.loadState()).state.timezone, 'Europe/Moscow');
  assert.equal((await state.loadState()).state.permissionMode, 'auto');
  assert.equal((await state.loadState()).state.ccSessionId, 'fixture-session');
  await fs.mkdir(path.join(home, '.codex'));
  const auth = '{"auth_mode":"chatgpt","tokens":{"access_token":"fixture-only"}}';
  await fs.writeFile(path.join(home, '.codex/auth.json'), auth);
  await fs.writeFile(path.join(home, '.codex/config.toml'), 'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "xhigh"\napproval_policy = "never"\n');
  const { ensureCodexStableTransport } = await load('bot/ext/codex-transport.mjs');
  await ensureCodexStableTransport(home);
  const config = await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8');
  assert.match(config, /model_providers\.iia_http/);
  assert.doesNotMatch(config, /model_providers\.msb_http/);
  await ensureCodexStableTransport(home);
  assert.equal(await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8'), config);
  assert.equal(await fs.readFile(path.join(home, '.codex/auth.json'), 'utf8'), auth);
  assert.equal(await fs.stat(path.join(home, '.msb')).then(() => true, () => false), false);
  await fs.mkdir(path.join(home, '.iia/bot'), { recursive: true });
  await fs.writeFile(path.join(home, '.iia/bot/OPEN-CORE.md'), 'fixture marker');
  const deny = path.join(home, 'deny.mjs');
  await fs.writeFile(deny, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; const deny=()=>{throw Error('Forbidden external effect in guard smoke')}; globalThis.fetch=deny; http.request=http.get=https.request=https.get=deny; net.connect=net.createConnection=deny; for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) child[k]=deny; syncBuiltinESMExports();`);
  for (const entry of ['puller.cjs', 'sync.cjs']) {
    const result = spawnSync(process.execPath, [path.join(runtime, entry)], {
      env: { HOME: home, PATH: '/nonexistent', IIA_BOT_ID: 'default', LIVE_DIR: path.join(home, '.iia'),
        NODE_OPTIONS: `--import=${pathToFileURL(deny).href}` }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, `${entry}: ${result.stderr}`);
    assert.match(result.stdout + result.stderr, /open-core.*skipped/);
  }
  console.log('PASS: exported JAR1 profile, paths, shared STT, state, iia_http and both updater guards');
} finally {
  await fs.rm(home, { recursive: true, force: true });
}
