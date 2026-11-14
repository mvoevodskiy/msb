/**
 * Codex through Telegram admission, the real runner and an owned fake CLI.
 * Old ingress/queue reference: blob 73aa9e7e:109826-109879, 110229-110247.
 * No real Telegram, provider, credentials, system service or model is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { loadState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';

async function until(check, label) {
  const deadline = Date.now() + 8_000;
  while (!await check()) {
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('Codex resumes its selected conversation after the sleep gate', async t => {
  const f = await fixture(t, runAgentTurn);
  const bin = path.join(f.home, '.local/bin');
  process.env.CODEX_HOME = path.join(f.home, 'native-codex');
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.MSB_CC_ONLY = '1';
  delete process.env.JARVIS_CC_ONLY;
  for (const key of ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY', 'MSB_ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY']) delete process.env[key];
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
  await fs.writeFile(path.join(process.env.CODEX_HOME, 'config.toml'), '# synthetic Codex profile\n');
  const native = await nativeFixtures(f);
  await native.respond('fixture Codex reply');
  const executions = async () => (await native.trace()).filter(row => row.kind === 'codex-exec');
  const preferences = JSON.parse(await fs.readFile(f.storeFile, 'utf8'));
  const initial = (await loadState()).state;

  await f.message('first synthetic message');
  await until(() => f.edits.some(text => text.includes('fixture Codex reply')), 'first Codex reply');
  const first = await executions();
  assert.equal(first.length, 1);
  assert.ok(first[0].prompt.includes('first synthetic message'));
  assert.ok(first[0].argv.includes('resume'));
  assert.ok(first[0].argv.includes(initial.ccSessionId.replace('ext:codex:', '')));
  const storeBeforePause = await fs.readFile(f.storeFile, 'utf8');
  const selectedBeforePause = JSON.parse(storeBeforePause);
  assert.deepEqual(selectedBeforePause.models, preferences.models);
  assert.deepEqual(selectedBeforePause.efforts, preferences.efforts);

  const marker = path.join(process.env.MSB_RUNTIME_ROOT, 'engine', 'sleep.default');
  await fs.mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  await fs.writeFile(marker, 'fixture');
  await f.message('blocked synthetic message');
  assert.equal((await executions()).length, 1);
  const during = (await loadState()).state;
  assert.equal(during.ccSessionId, initial.ccSessionId);
  assert.equal(during.extAuthBypass, 'codex');
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), storeBeforePause);

  const originalLstat = fs.lstat;
  fs.lstat = async (file, ...args) => String(file) === marker
    ? Promise.reject(Object.assign(Error('fixture'), { code: 'EACCES' })) : originalLstat(file, ...args);
  t.after(() => { fs.lstat = originalLstat; });
  await f.message('unreadable marker synthetic message');
  assert.equal((await executions()).length, 1);
  assert.equal((await loadState()).state.ccSessionId, initial.ccSessionId);
  fs.lstat = originalLstat;

  await f.callback('eng:wake');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  await f.message('after wake synthetic message');
  await until(async () => (await executions()).length === 2, 'resumed Codex launch');
  await until(() => f.edits.filter(text => text.includes('fixture Codex reply')).length === 2, 'resumed Codex reply');
  const resumed = (await executions())[1];
  assert.ok(resumed.prompt.includes('after wake synthetic message'));
  assert.ok(resumed.argv.includes('resume'));
  assert.ok(resumed.argv.includes(initial.ccSessionId.replace('ext:codex:', '')));
  const selectedAfterWake = JSON.parse(await fs.readFile(f.storeFile, 'utf8'));
  assert.deepEqual(selectedAfterWake.models, preferences.models);
  assert.deepEqual(selectedAfterWake.efforts, preferences.efforts);
  assert.equal((await loadState()).state.ccSessionId, initial.ccSessionId);
});
