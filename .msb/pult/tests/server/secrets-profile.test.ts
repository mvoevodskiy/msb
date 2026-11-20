import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'pult-secrets-profile-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secrets = join(home, 'pult-secrets');
  const data = join(home, 'pult-data');
  const source = readFileSync(new URL('../../deploy/secrets.sh', import.meta.url), 'utf8');
  assert.equal(source.split('SECRETS=/home/client/pult-secrets').length, 2);
  assert.equal(source.split('DATA=/home/client/pult-data').length, 2);
  // Redirect only the two fixed storage roots; execute the unchanged writer body.
  const script = source.replace('SECRETS=/home/client/pult-secrets', `SECRETS=${secrets}`)
    .replace('DATA=/home/client/pult-data', `DATA=${data}`);
  const run = (env: NodeJS.ProcessEnv = {}) => {
    execFileSync('/bin/bash', ['-c', script, 'secrets.sh', '--public-url', 'https://pult.invalid'], {
      env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        PULT_PASSWORD: 'synthetic-test-password', ...env },
      stdio: 'pipe',
    });
    return readFileSync(join(secrets, 'web.env'), 'utf8');
  };
  return { run, secrets };
}

test('secrets writer leaves MSB discovery default and writes the JAR1 directory for its profile', t => {
  const { run } = fixture(t);
  assert.doesNotMatch(run(), /^PULT_BOTS_DIR=/m);
  const jar1 = run({ MSB_RUNTIME_PROFILE: 'jar1' });
  assert.match(jar1, /^PULT_BOTS_DIR=\/home\/client\/\.iia\/bots$/m);
  assert.match(run(), /^PULT_BOTS_DIR=\/home\/client\/\.iia\/bots$/m);
});

test('explicit bots directory wins over ROOT and survives a later secrets reload', t => {
  const { run } = fixture(t);
  const env = { MSB_RUNTIME_PROFILE: 'jar1', PULT_BOTS_DIR: '/fixture/bots with spaces',
    PULT_BOTS_ROOT: '/wrong/profile' };
  assert.match(run(env), /^PULT_BOTS_DIR="\/fixture\/bots with spaces"$/m);
  assert.match(run({ MSB_RUNTIME_PROFILE: 'jar1' }), /^PULT_BOTS_DIR="\/fixture\/bots with spaces"$/m);
});

test('ROOT alias is persisted as the canonical directory, including an existing secrets file', t => {
  const { run, secrets } = fixture(t);
  mkdirSync(secrets);
  writeFileSync(join(secrets, 'web.env'), 'PULT_BOTS_ROOT="/fixture/legacy bots"\n');
  assert.match(run(), /^PULT_BOTS_DIR="\/fixture\/legacy bots"$/m);
  assert.match(run({ PULT_BOTS_ROOT: '/fixture/explicit' }), /^PULT_BOTS_DIR="\/fixture\/explicit"$/m);
});
