import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import profile from '../shared/profile.cjs';
import { botRoot, sessionDir, workspaceDir } from '../src/paths.mjs';
import { readConfig } from '../src/config.mjs';
import { monitorDir } from '../src/monitor/config.mjs';
import { setEnvKey, deleteEnvKey } from '../src/env/store.mjs';
import { botDir, extToolsBin } from '../../../overlay/bot/ext/paths.mjs';
import { botEnvPath, globalEnvPath, readEnvKey } from '../../../overlay/bot/ext/env.mjs';
import { storePath, setActive, loadStore } from '../../../overlay/bot/ext/store.mjs';
import { enrichPath } from '../../../overlay/bot/ext/ensure-cli.mjs';
import { hydrateLocalSshHost, setLocalSshHost } from '../../../overlay/bot/ext/local-ssh.mjs';
import { updatesStatePath, writeUpdatesState, detectCoreVersion } from '../../../overlay/bot/ext/update/core-id.mjs';
import { ensureCodexStableTransport } from '../../../overlay/bot/ext/codex-transport.mjs';
import { buildCodexExecArgs } from '../../../overlay/bot/ext/adapters/codex.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const shared = fileURLToPath(new URL('../shared/', import.meta.url));
const require = createRequire(import.meta.url);
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-runtime-profile-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}
async function packageProfile(dir) {
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(shared, path.join(dir, 'shared'), { recursive: true, dereference: true });
  await fs.writeFile(path.join(dir, 'runtime-profile.json'), JSON.stringify({ profile: 'jar1' }));
}

test('profile precedence is explicit profile, environment namespace, then release default; HOME is not cached', () => {
  assert.equal(profile.resolveProfile({}, '/one', 'jar1').root, '/one/.iia');
  assert.equal(profile.resolveProfile({}, '/two', 'jar1').root, '/two/.iia');
  assert.equal(profile.resolveProfile({ HOME: '/fake', MSB_BOT_ID: 'default' }, undefined, 'jar1').id, 'msb');
  assert.equal(profile.resolveProfile({ HOME: '/fake', IIA_BOT_ID: 'default' }, undefined, 'msb').id, 'jar1');
  assert.equal(profile.resolveProfile({ MSB_RUNTIME_PROFILE: 'jar1', MSB_BOT_ID: 'default' }, '/fake').id, 'jar1');
  assert.equal(profile.resolveProfile({ MSB_BOT_ID: '', IIA_BOT_ID: 'legacy' }, '/fake').id, 'msb');
  assert.equal(profile.resolveProfile({ MSB_RUNTIME_PROFILE: 'jar1', MSB_RUNTIME_ROOT: '/explicit/root' }, '/fake').root, '/explicit/root');
  assert.throws(() => profile.resolveProfile({ MSB_RUNTIME_PROFILE: 'unknown' }), /Unknown runtime profile/);
  for (const flag of ['MSB_OS_ENGINE', 'IIA_OS_ENGINE']) {
    assert.throws(() => profile.initialize({ MSB_RUNTIME_PROFILE: 'jar1', [flag]: 'native' }), /does not enable native OS-engine/);
  }
});

test('preload aliases preserve explicit MSB values and native auth without writing legacy env files', async t => {
  const home = await fixture(t);
  const env = {
    HOME: home, IIA_BOT_ID: 'voice', IIA_TIMEZONE: 'UTC', IIA_SESSION_DIR: path.join(home, 'sessions'),
    IIA_WORKSPACE_DIR: path.join(home, 'workspace'), IIA_REAL_CLAUDE: '/fixture/claude',
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-claude', CODEX_HOME: path.join(home, 'native-codex'),
  };
  profile.initialize(env);
  assert.equal(env.MSB_RUNTIME_PROFILE, 'jar1');
  assert.equal(env.MSB_OS_ENGINE, 'legacy');
  assert.equal(env.MSB_REAL_CLAUDE, '/fixture/claude');
  assert.equal(env.HOME, home);
  assert.equal(env.CODEX_HOME, path.join(home, 'native-codex'));
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-claude');
  assert.equal(sessionDir(env), env.IIA_SESSION_DIR);
  assert.equal(workspaceDir(env), env.IIA_WORKSPACE_DIR);
  assert.equal(botRoot(env), path.join(home, '.iia/bots/voice'));
  assert.equal(botDir(env), botRoot(env));
  assert.equal(monitorDir(env), path.join(home, '.iia/monitor'));
  assert.equal(storePath(env), path.join(botRoot(env), 'ext-providers.json'));
  assert.equal(globalEnvPath(home, env), path.join(home, '.iia/.env'));
  assert.equal(enrichPath(env).split(path.delimiter)[0], extToolsBin(home, env));
  await setActive('codex', env);
  assert.equal((await loadStore(env)).active, 'codex');
  assert.equal(updatesStatePath(home, env), path.join(home, '.iia/updates/state.json'));
  await writeUpdatesState({ applied_core_version: 'fixture-core' }, home, env);
  assert.equal(await detectCoreVersion(home, env), 'fixture-core');

  const file = botEnvPath(env);
  await fs.writeFile(file, 'IIA_BOT_ID=voice\nIIA_TIMEZONE=UTC\nKEEP=unchanged\n');
  await setEnvKey('IIA_TIMEZONE', 'Europe/Riga', env);
  assert.equal(readConfig(env).timezone, 'Europe/Riga');
  assert.equal(env.MSB_TIMEZONE, 'Europe/Riga');
  assert.equal(await fs.readFile(file, 'utf8'), 'IIA_BOT_ID=voice\nIIA_TIMEZONE=Europe/Riga\nKEEP=unchanged\n');
  await deleteEnvKey('IIA_TIMEZONE', env);
  assert.equal(env.MSB_TIMEZONE, undefined, 'Deleting an injected alias also removes its canonical mirror.');
  await assert.rejects(deleteEnvKey('IIA_BOT_ID', env), /защищён/);
  const explicit = { HOME: home, IIA_BOT_ID: 'voice', IIA_TIMEZONE: 'UTC', MSB_TIMEZONE: 'Europe/Paris' };
  profile.initialize(explicit);
  profile.setEnvValue(explicit, 'IIA_TIMEZONE', 'Europe/Riga');
  assert.equal(explicit.MSB_TIMEZONE, 'Europe/Paris');
  const blank = { IIA_TIMEZONE: 'UTC', MSB_TIMEZONE: '' };
  profile.initialize(blank); assert.equal(blank.MSB_TIMEZONE, '');
  await assert.rejects(fs.access(path.join(home, '.msb')));
});

test('jar1 local env hydration and writes keep IIA keys in the existing files', async t => {
  const home = await fixture(t);
  const env = { HOME: home, IIA_BOT_ID: 'default' };
  profile.initialize(env);
  const file = botEnvPath(env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'IIA_LOCAL_SSH_HOST=127.0.0.1\nKEEP=unchanged\n');
  const before = await fs.readFile(file, 'utf8');
  assert.equal(await hydrateLocalSshHost(env), '127.0.0.1');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(env.MSB_LOCAL_SSH_HOST, '127.0.0.1');
  assert.equal(await readEnvKey('MSB_LOCAL_SSH_HOST', { HOME: home, IIA_BOT_ID: 'default' }), '127.0.0.1');
  await setLocalSshHost('192.168.33.203', env);
  assert.equal(await fs.readFile(file, 'utf8'), 'IIA_LOCAL_SSH_HOST=192.168.33.203\nKEEP=unchanged\n');
  assert.equal((await fs.readFile(globalEnvPath(home, env), 'utf8')).trim(), 'IIA_LOCAL_SSH_HOST=192.168.33.203');
  assert.equal(env.MSB_LOCAL_SSH_HOST, '192.168.33.203');
});

test('the shared source works unchanged in separately packed core and overlay layouts with jar1 release data', async t => {
  const root = await fixture(t);
  assert.equal(await fs.realpath(path.join(repo, 'overlay/bot/shared/profile.cjs')), await fs.realpath(path.join(shared, 'profile.cjs')));
  for (const kind of ['core', 'overlay']) {
    const pkg = path.join(root, kind, 'bot');
    await packageProfile(pkg);
    const sub = kind === 'core' ? 'src' : 'ext';
    const source = kind === 'core' ? path.join(repo, '.msb/bot/src/paths.mjs') : path.join(repo, 'overlay/bot/ext/paths.mjs');
    await fs.mkdir(path.join(pkg, sub), { recursive: true });
    await fs.copyFile(source, path.join(pkg, sub, 'paths.mjs'));
    assert.deepEqual(await fs.readFile(path.join(pkg, 'shared/profile.cjs')), await fs.readFile(path.join(shared, 'profile.cjs')));
    const packed = require(path.join(pkg, 'shared/profile.cjs'));
    assert.equal(packed.resolveProfile({ HOME: path.join(root, 'one') }).root, path.join(root, 'one/.iia'));
    assert.equal(packed.resolveProfile({ HOME: path.join(root, 'two') }).root, path.join(root, 'two/.iia'));
    assert.equal(packed.resolveProfile({ HOME: root, MSB_BOT_ID: 'default' }).id, 'msb');
    const paths = await import(pathToFileURL(path.join(pkg, sub, 'paths.mjs')).href);
    const env = { HOME: root };
    assert.equal(kind === 'core' ? paths.botRoot(env) : paths.botDir(env), path.join(root, '.iia/bots/default'));
    const output = execFileSync(process.execPath, ['--import', pathToFileURL(path.join(pkg, 'shared/preload.mjs')).href,
      '-e', 'process.stdout.write(JSON.stringify({profile:process.env.MSB_RUNTIME_PROFILE,mode:process.env.MSB_OS_ENGINE,id:process.env.MSB_BOT_ID,home:process.env.HOME}))'], {
      env: { HOME: root, PATH: path.dirname(process.execPath), IIA_BOT_ID: 'fixture' }, encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(output), { profile: 'jar1', mode: 'legacy', id: 'fixture', home: root });
  }
});

test('jar1 reuses the native iia_http block byte-for-byte and passes that exact provider to Codex', async t => {
  const home = await fixture(t);
  const env = { HOME: home, MSB_RUNTIME_PROFILE: 'jar1' };
  const native = path.join(home, '.codex');
  await fs.mkdir(native);
  const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-only' } });
  const config = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "max"\n\n'
    + '# BEGIN iia-ext codex-http\n# HTTP-only: без Responses WebSocket (см. openai/codex#20739, #22634)\n'
    + 'model_provider = "iia_http"\nstream_idle_timeout_ms = 600000\n\n[model_providers.iia_http]\n'
    + 'name = "IIA HTTP (no websocket)"\nbase_url = "https://chatgpt.com/backend-api/codex"\n'
    + 'wire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n# END iia-ext codex-http\n';
  await fs.writeFile(path.join(native, 'auth.json'), auth);
  await fs.writeFile(path.join(native, 'config.toml'), config);
  await fs.mkdir(path.join(home, '.claude'));
  await fs.writeFile(path.join(home, '.claude/fixture-auth'), 'unchanged');
  for (const requestEnv of [env, { HOME: home, MSB_RUNTIME_PROFILE: 'msb' }]) {
    const transport = await ensureCodexStableTransport(home, requestEnv);
    assert.equal(transport.providerId, 'iia_http');
    assert.equal(transport.changed, false);
    const args = buildCodexExecArgs({ model: 'gpt-6.1-sol', effort: 'max', httpProviderId: transport.providerId });
    assert.ok(args.includes('model_provider="iia_http"'));
    assert.ok(!args.some(arg => arg.includes('msb_http')));
  }
  assert.equal(await fs.readFile(path.join(native, 'config.toml'), 'utf8'), config);
  assert.equal(await fs.readFile(path.join(native, 'auth.json'), 'utf8'), auth);
  assert.equal(await fs.readFile(path.join(home, '.claude/fixture-auth'), 'utf8'), 'unchanged');
});

test('packed legacy puller and sync stop at the selected open-core marker before platform work', async t => {
  const home = await fixture(t);
  const root = path.join(home, '.iia');
  await packageProfile(path.join(root, 'bot'));
  await fs.writeFile(path.join(root, 'bot/OPEN-CORE.md'), 'fixture open-core');
  const unrelatedHome = path.join(home, 'unrelated-user');
  await fs.mkdir(unrelatedHome);
  assert.equal(profile.shouldSkipVendorUpdate('puller', { HOME: unrelatedHome }, root), true);
  assert.equal(profile.shouldSkipVendorUpdate('sync', { HOME: unrelatedHome }, root), true);
  assert.equal(profile.shouldSkipVendorUpdate('puller', { HOME: unrelatedHome, LIVE_DIR: unrelatedHome }, root), false,
    'An explicit puller LIVE_DIR takes precedence over the script location.');
  assert.equal(profile.shouldSkipVendorUpdate('sync', { HOME: unrelatedHome, LIVE_DIR: unrelatedHome }, root), true);
  const deny = path.join(home, 'deny.cjs');
  await fs.writeFile(deny, `const deny=()=>{throw Error('Network/process is forbidden in profile guard test')};
for(const name of ['http','https']){const m=require(name);m.request=m.get=deny}
const net=require('net');net.connect=net.createConnection=net.Socket.prototype.connect=deny;
require('tls').connect=deny;globalThis.fetch=deny;
const cp=require('child_process');for(const key of ['spawn','spawnSync','exec','execFile','execSync','execFileSync','fork'])cp[key]=deny;
require('module').syncBuiltinESMExports();
const initialHome=process.env.HOME;
process.on('exit',()=>{if(process.env.HOME!==initialHome)throw Error('Updater changed HOME')});\n`);
  for (const entry of ['puller.cjs', 'sync.cjs']) {
    const source = path.join(repo, '.msb', entry), dest = path.join(root, entry);
    await fs.copyFile(source, dest);
    assert.deepEqual(await fs.readFile(dest), await fs.readFile(source));
    for (const env of [{ HOME: home, LIVE_DIR: root }, { HOME: unrelatedHome }]) {
      const result = execFileSync(process.execPath, ['--require', deny, dest], {
        env: { ...env, PATH: path.dirname(process.execPath) }, encoding: 'utf8', timeout: 3000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(result, '');
    }
  }
  await assert.rejects(fs.access(path.join(home, '.msb')));
  await assert.rejects(fs.access(path.join(home, '.scripter')));
  assert.deepEqual(await fs.readdir(unrelatedHome), [], 'No updater state may appear under the unrelated account HOME.');
});
