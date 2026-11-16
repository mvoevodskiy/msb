/** Observational baseline for the simple interval's native Codex argv.
 * Uses temporary profile, owned fake CLI, fake Telegram and no real model.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', fileURLToPath(import.meta.url)], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR || '/tmp' }, stdio: 'inherit', timeout: 30000,
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
const { mock } = await import('node:test');
const mod = relative => new URL(`../../src/${relative}`, import.meta.url).href;
const idle = () => async () => {};
mock.module(mod('autonomy/openclaw-reminder-dispatch.mjs'), { namedExports: { createOpenClawReminderDispatcher: idle } });
mock.module(mod('autonomy/reminder-dispatch.mjs'), { namedExports: { createReminderDispatcher: idle } });
mock.module(mod('autonomy/legacy-dispatch.mjs'), { namedExports: { dispatchLegacyTimers: async () => {}, admitLegacyTimerRuns: async () => [] } });
const { fixture } = await import('../helpers/menu-fixture.mjs');
const { nativeFixtures } = await import('../helpers/mcp-launch-fixture.mjs');
const { startScheduler } = await import('../../src/autonomy/scheduler.mjs');
const { runAgentTurn } = await import('../../src/agent/turn.mjs');
const { addTask } = await import('../../src/autonomy/store.mjs');
const { loadState, saveState } = await import('../../src/state.mjs');
const cleanups = [], t = { after: fn => cleanups.push(fn) };
let scheduler;
try {
  const f = await fixture(t, undefined, { overlay: false });
  const bin = path.join(f.home, '.local', 'bin');
  await fs.mkdir(bin, { recursive: true });
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  const native = await nativeFixtures(f);
  await fs.access(path.join(bin, 'codex'), fs.constants.X_OK);
  const fakeProfile = path.join(f.home, '.codex');
  await fs.mkdir(fakeProfile, { recursive: true });
  await fs.writeFile(path.join(fakeProfile, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  delete process.env.OPENAI_API_KEY;
  await native.respond('synthetic');
  const selected = (await loadState()).state;
  await saveState({ ...selected, authMode: 'subscription', hasSubscriptionAuth: true });
  scheduler = startScheduler({ log() {}, runTurn: runAgentTurn });
  for (const setting of [false, true]) {
    const state = (await loadState()).state;
    await saveState({ ...state, autonomyRights: setting });
    await addTask({ id: setting ? 'on' : 'off', prompt: 'synthetic', nextAt: Date.now() - 1000, everyHours: 1 });
    await scheduler.tickNow();
    const calls = (await native.trace()).filter(row => row.kind === 'codex-exec');
    assert.equal(calls.length, setting ? 2 : 1);
    const argv = calls.at(-1).argv;
    assert.equal(argv[argv.indexOf('--sandbox') + 1], 'danger-full-access');
    assert.ok(argv.includes('approval_policy="never"'));
    assert.equal((await loadState()).state.autonomyRights, setting);
  }
  console.log('OBSERVED: the simple Codex interval uses the ordinary full-access CLI mode with either rights toggle value.');
  console.log('Only launch arguments were checked; OS user, sudo privileges and actual file access were not tested.');
} finally {
  if (scheduler) await scheduler.stop();
  for (const cleanup of cleanups.reverse()) await cleanup();
}
