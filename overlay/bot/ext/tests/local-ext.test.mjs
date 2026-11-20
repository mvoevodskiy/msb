import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MSB_LOCAL_API,
  localExtRoot,
  loadLocalExt,
  runLocalExtCallback,
  getLocalExtSummary,
  formatLocalExtStatus,
  resetLocalExtState,
} from '../local-ext.mjs';
import { assertSafeExtInstallPath } from '../update/safe-path.mjs';
import { applyExt } from '../update/client.mjs';
import { msbRoot } from '../paths.mjs';

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'msb-local-ext-'));
}

async function writePkg(home, id, manifest, files = {}) {
  const dir = path.join(localExtRoot(home), id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id, msbApi: 1, version: '1.0.0', ...manifest }, null, 2));
  for (const [name, body] of Object.entries(files)) {
    const abs = path.join(dir, name);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return dir;
}

test('без local/ — no-op, summary нули', async () => {
  resetLocalExtState();
  const home = await tmpHome();
  const env = { MSB_BOT_ID: 'default', HOME: home };
  const r = await loadLocalExt({ apiVersion: MSB_LOCAL_API, home, env, force: true });
  assert.equal(r.packages.length, 0);
  assert.deepEqual(getLocalExtSummary(), { ok: 0, skip: 0, error: 0 });
  assert.equal(formatLocalExtStatus(), null);
  assert.equal(await runLocalExtCallback({ data: 'x' }), false);
});

test('заглушка: onPrepare и onCallback вызываются', async () => {
  resetLocalExtState();
  const home = await tmpHome();
  const env = { MSB_BOT_ID: 'default', HOME: home };
  const marker = path.join(home, 'hooks.log');
  await writePkg(home, 'stub-log', {
    onPrepare: './prepare.mjs',
    onCallback: './callback.mjs',
  }, {
    'prepare.mjs': `
      import fs from 'node:fs/promises';
      export default async function onPrepare({ log }) {
        log('prepare');
        await fs.appendFile(${JSON.stringify(marker)}, 'prepare\\n');
      }
    `,
    'callback.mjs': `
      import fs from 'node:fs/promises';
      export default async function onCallback({ data }) {
        await fs.appendFile(${JSON.stringify(marker)}, 'callback:' + data + '\\n');
        return data === 'local:stub';
      }
    `,
  });

  await loadLocalExt({ apiVersion: MSB_LOCAL_API, home, env, force: true });
  assert.equal(getLocalExtSummary().ok, 1);
  assert.match((await fs.readFile(marker, 'utf8')), /prepare/);

  assert.equal(await runLocalExtCallback({ data: 'other' }), false);
  assert.equal(await runLocalExtCallback({ data: 'local:stub' }), true);
  const log = await fs.readFile(marker, 'utf8');
  assert.match(log, /callback:other/);
  assert.match(log, /callback:local:stub/);
});

test('повторная «выкладка» bot/** не трогает local/ — хуки снова работают', async () => {
  resetLocalExtState();
  const home = await tmpHome();
  const env = { MSB_BOT_ID: 'default', HOME: home };
  const root = msbRoot(home, env);
  await writePkg(home, 'survive', {
    onPrepare: './prepare.mjs',
  }, {
    'prepare.mjs': `export default async function () { return; }`,
  });
  const localFile = path.join(localExtRoot(home), 'survive', 'manifest.json');
  const before = await fs.readFile(localFile, 'utf8');

  // Имитация applyExt: перезапись только managed-дерева релиза.
  const botFile = path.join(root, 'bot', 'ext', 'dummy.txt');
  await fs.mkdir(path.dirname(botFile), { recursive: true });
  await fs.writeFile(botFile, 'release-v1');
  await fs.writeFile(botFile, 'release-v2');

  assert.equal(await fs.readFile(localFile, 'utf8'), before);
  resetLocalExtState();
  const r = await loadLocalExt({ apiVersion: MSB_LOCAL_API, home, env, force: true });
  assert.equal(r.packages.length, 1);
  assert.equal(r.packages[0].id, 'survive');
});

test('msbApi выше контракта — skip, загрузка остальных продолжается', async () => {
  resetLocalExtState();
  const home = await tmpHome();
  const env = { MSB_BOT_ID: 'default', HOME: home };
  await writePkg(home, 'future', { msbApi: MSB_LOCAL_API + 5, onPrepare: './p.mjs' }, {
    'p.mjs': `export default async function () { throw new Error('must not run'); }`,
  });
  await writePkg(home, 'ok-pkg', { order: 1, onPrepare: './p.mjs' }, {
    'p.mjs': `export default async function () { return; }`,
  });

  const r = await loadLocalExt({ apiVersion: MSB_LOCAL_API, home, env, force: true });
  assert.equal(r.summary.skip, 1);
  assert.equal(r.summary.ok, 1);
  assert.deepEqual(r.packages.map((p) => p.id), ['ok-pkg']);
  assert.match(formatLocalExtStatus(r.summary), /local: 1 ok \/ 1 skip/);
});

test('исключение в onPrepare — бот (загрузка) продолжается, пакет в error', async () => {
  resetLocalExtState();
  const home = await tmpHome();
  const env = { MSB_BOT_ID: 'default', HOME: home };
  await writePkg(home, 'boom', { order: 1, onPrepare: './p.mjs' }, {
    'p.mjs': `export default async function () { throw new Error('boom-prepare'); }`,
  });
  await writePkg(home, 'alive', { order: 2, onPrepare: './p.mjs' }, {
    'p.mjs': `export default async function () { return; }`,
  });

  const r = await loadLocalExt({ apiVersion: MSB_LOCAL_API, home, env, force: true });
  assert.equal(r.summary.error, 1);
  assert.equal(r.summary.ok, 1);
  assert.deepEqual(r.packages.map((p) => p.id), ['alive']);
});

test('исключение в onCallback — следующие пакеты и false в итоге', async () => {
  resetLocalExtState();
  const home = await tmpHome();
  const env = { MSB_BOT_ID: 'default', HOME: home };
  await writePkg(home, 'a-boom', { order: 1, onCallback: './c.mjs' }, {
    'c.mjs': `export default async function () { throw new Error('cb-boom'); }`,
  });
  await writePkg(home, 'b-ok', { order: 2, onCallback: './c.mjs' }, {
    'c.mjs': `export default async function ({ data }) { return data === 'take'; }`,
  });
  await loadLocalExt({ apiVersion: MSB_LOCAL_API, home, env, force: true });
  assert.equal(await runLocalExtCallback({ data: 'take' }), true);
  assert.equal(await runLocalExtCallback({ data: 'nope' }), false);
});

test('порядок: order, иначе id', async () => {
  resetLocalExtState();
  const home = await tmpHome();
  const env = { MSB_BOT_ID: 'default', HOME: home };
  const seen = path.join(home, 'order.log');
  for (const [id, order] of [['z-last', 30], ['a-mid', 20], ['m-first', 10]]) {
    await writePkg(home, id, { order, onPrepare: './p.mjs' }, {
      'p.mjs': `
        import fs from 'node:fs/promises';
        export default async function ({ id }) {
          await fs.appendFile(${JSON.stringify(seen)}, id + '\\n');
        }
      `,
    });
  }
  await loadLocalExt({ apiVersion: MSB_LOCAL_API, home, env, force: true });
  assert.equal((await fs.readFile(seen, 'utf8')).trim(), 'm-first\na-mid\nz-last');
});

test('assertSafeExtInstallPath: local/ запрещён, bot/** разрешён', () => {
  assert.equal(assertSafeExtInstallPath('bot/ext/foo.mjs'), 'bot/ext/foo.mjs');
  assert.throws(() => assertSafeExtInstallPath('local/ext/x/manifest.json'), /refusing local/);
  assert.throws(() => assertSafeExtInstallPath('local'), /refusing local/);
  assert.throws(() => assertSafeExtInstallPath('../etc/passwd'), /bad path/);
  assert.throws(() => assertSafeExtInstallPath('bot/../local/secret'), /bad path/);
});

test('applyExt preserves the owner package when a release path points to it', async t => {
  const home = await tmpHome();
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home, MSB_UPDATES_URL: 'https://updates.example', MSB_UPDATES_TOKEN: 'fixture' };
  const root = msbRoot(home, env);
  const owner = await writePkg(home, 'owner', {});
  const target = path.join(owner, 'manifest.json');
  const before = await fs.readFile(target, 'utf8');
  await fs.mkdir(path.join(root, 'bot/ext'), { recursive: true });
  await fs.symlink(owner, path.join(root, 'bot/ext/demo'), 'dir');
  const bytes = Buffer.from('released fixture');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  t.mock.method(globalThis, 'fetch', async url => url.includes('/channels/')
    ? new Response(JSON.stringify({ release: { version: 'test', files: [{ path: 'bot/ext/demo/manifest.json', sha256 }] } }))
    : new Response(bytes));

  const outcome = await applyExt(env, home).catch(error => error);
  assert.equal(await fs.readFile(target, 'utf8'), before);
  assert.match(outcome.message, /refusing local/);
});
