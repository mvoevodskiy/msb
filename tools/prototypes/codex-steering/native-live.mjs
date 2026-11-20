/**
 * Opt-in live-model probe of [prototype queue](./queue.mjs) and an ephemeral
 * [native thread](./session.mjs). The caller must supply a disposable profile;
 * this script never reads or copies any account credentials. See README.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PrototypeQueue } from './queue.mjs';
import { NativeSession } from './session.mjs';
import { assertNoSavedSessions } from './ephemeral.mjs';

const [binary, workspace, marker] = process.argv.slice(2);
assert.equal(marker, '--allow-live-model', 'live model use must be explicitly enabled');
assert.ok(binary && path.isAbsolute(binary) && workspace && path.isAbsolute(workspace));
assert.ok(process.env.JARVIS_STEER_TEST_ROOT && process.env.CODEX_HOME && process.env.HOME);
const root = await fs.realpath(process.env.JARVIS_STEER_TEST_ROOT);
assert.equal(root, path.resolve(process.env.JARVIS_STEER_TEST_ROOT), 'test root must not be a symlink');
assert.equal(path.dirname(root), await fs.realpath('/tmp'), 'test root must be a direct temporary-directory child');
assert.match(path.basename(root), /^jarvis-steer-live-[A-Za-z0-9_-]+$/);
const rootStat = await fs.lstat(root);
assert.ok(rootStat.isDirectory() && rootStat.uid === process.getuid() && (rootStat.mode & 0o777) === 0o700);
for (const [value, expected] of [[workspace, 'workspace'], [process.env.CODEX_HOME, 'profile'], [process.env.HOME, 'user']]) {
  assert.equal(await fs.realpath(value), path.join(root, expected), 'profile must be a dedicated test directory');
  const stat = await fs.lstat(value);
  assert.ok(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700);
}
assert.deepEqual((await fs.readdir(process.env.CODEX_HOME)).sort(), ['auth.json', 'config.toml']);
assert.deepEqual(await fs.readdir(workspace), []);
assert.deepEqual(await fs.readdir(process.env.HOME), []);
for (const name of ['auth.json', 'config.toml']) {
  const stat = await fs.lstat(path.join(process.env.CODEX_HOME, name));
  assert.ok(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077),
    'test profile must be private and not hard-linked');
}
const safeEnv = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, TMPDIR: root,
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
const disabled = ['apps', 'plugins', 'remote_plugin', 'hooks', 'shell_tool', 'shell_snapshot', 'unified_exec',
  'browser_use', 'computer_use', 'code_mode', 'goals', 'image_generation', 'view_image', 'memories',
  'multi_agent', 'multi_agent_v2', 'enable_mcp_apps'];
const appArgs = [...disabled.flatMap(name => ['--disable', name]), '-c', 'web_search="disabled"', '-c', 'mcp_servers={}'];

const events = [], nativeEvents = [];
const waitFor = async (predicate, label, timeout = 120_000) => {
  const end = Date.now() + timeout;
  while (!predicate()) {
    const failure = events.find(row => row.type === 'failed');
    if (failure) throw Error(`prototype turn failed: ${failure.error?.message || 'unknown'}`);
    if (Date.now() >= end) throw Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const messageFor = turnId => nativeEvents.filter(row => row.method === 'item/completed' &&
  row.params?.turnId === turnId && row.params?.item?.type === 'agentMessage')
  .map(row => row.params.item.text).join('\n');
let session, queue, outcome;
try {
  session = await NativeSession.open({ command: binary, cwd: workspace, env: safeEnv, args: appArgs,
    timeoutMs: 60_000, onEvent: row => nativeEvents.push(row) });
  queue = new PrototypeQueue({ driver: session, notify: row => events.push(row) });
  queue.submit({ id: 'initial', text: 'Test only: list the numbers from 1 to 1000 and end with ORIGINAL_471. ' +
    'Do not use tools or access files.' });
  await waitFor(() => queue.active?.id, 'first live turn');
  const firstTurn = queue.active.id;
  queue.submit({ id: 'correction', text: 'Correction: stop listing numbers and answer exactly STEER_382 instead.' });
  queue.submit({ id: 'queued', text: 'For this next turn answer exactly QUEUE_904, with no tools.' });
  assert.deepEqual(await queue.steer('correction'), { status: 'accepted' });
  console.log('steer accepted for the test turn');
  await waitFor(() => events.some(row => row.type === 'finished' && row.id === 'queued'), 'queued live turn');
  const started = events.filter(row => row.type === 'started');
  assert.equal(started.length, 2);
  assert.equal(started[0].turnId, firstTurn);
  assert.notEqual(started[0].turnId, started[1].turnId);
  assert.match(messageFor(firstTurn), /STEER_382/);
  assert.match(messageFor(started[1].turnId), /QUEUE_904/);

  queue.submit({ id: 'stop-current', text: 'Test only: list every integer from 1 to 10000. Do not use tools or access files.' });
  await waitFor(() => queue.active?.id, 'stoppable live turn');
  queue.submit({ id: 'stop-queued', text: 'Do not start this queued test message.' });
  assert.deepEqual(await queue.stop(), { cleared: ['stop-queued'], active: true });
  await waitFor(() => events.some(row => row.type === 'finished' && row.id === 'stop-current'), 'interrupted live turn');
  assert.equal(events.find(row => row.type === 'finished' && row.id === 'stop-current').status, 'interrupted');
  assert.equal(events.some(row => row.type === 'started' && row.id === 'stop-queued'), false);
  assert.equal(nativeEvents.some(row => row.method === 'item/started' &&
    ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(row.params?.item?.type)), false);
  outcome = { ephemeral_thread: true, live_model: true, same_turn_steered: true,
    correction_in_answer: true, queued_next_turn: true, stop_interrupted: true, stop_cleared_queue: true };
} catch (error) {
  console.error(JSON.stringify({ error: error.message,
    events: events.map(({ type, id, status }) => ({ type, id, status })) }));
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  if (queue) try { await queue.close(); } catch (error) { cleanupErrors.push(error.message); }
  if (session) try { await session.close(); } catch (error) { cleanupErrors.push(error.message); }
  if (outcome) try { await assertNoSavedSessions(process.env.CODEX_HOME); } catch (error) { cleanupErrors.push(error.message); }
  if (cleanupErrors.length) {
    console.error(JSON.stringify({ cleanup_not_confirmed: cleanupErrors }));
    process.exitCode = 1;
  }
  if (outcome && !cleanupErrors.length && !process.exitCode) console.log(JSON.stringify({ ...outcome, cleanup: 'leader-and-group-checked' }));
}
