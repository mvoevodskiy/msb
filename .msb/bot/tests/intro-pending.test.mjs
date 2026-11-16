import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createIntroPendingJournal } from '../src/agent/intro-pending.mjs';
import { botRoot } from '../src/paths.mjs';

const TMP = os.tmpdir();
const MODULE_URL = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/agent/intro-pending.mjs')).href;
const codexSession = 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(TMP, 'intro-pending-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home, MSB_BOT_ID: 'default' };
  const root = botRoot(env);
  return { home, env, root, directory: path.join(root, 'intro-pending'), journal: createIntroPendingJournal(env) };
}

function record(id = randomUUID(), overrides = {}) {
  const value = {
    id,
    prompt: 'synthetic prepared voice transcript and file path /private/tmp/fixture.media/photo.jpg',
    chatId: -10042,
    userId: 42,
    threadId: 17,
    incomingMessageId: 1001,
    statusId: 2001,
    updateId: undefined,
    sourceUpdateIds: [3001, 3002, 3001],
    requireCodex: true,
    sessionId: codexSession,
    activeSessionId: 'claude-session-fixture',
    project: 'alpha',
    epoch: 6,
    profileDir: '/private/tmp/fixture/.codex',
    workspace: '/private/tmp/fixture/workspace',
    cwd: '/private/tmp/fixture/workspace/projects/alpha',
    ...overrides,
  };
  if (overrides.scope === undefined) {
    const topic = value.threadId != null && value.threadId > 1 ? value.threadId : 0;
    value.scope = `${value.chatId}:${value.userId}:${topic}`;
  }
  return value;
}

async function runChild(env, action, input) {
  const source = [
    `const { createIntroPendingJournal } = await import(process.env.INTRO_PENDING_MODULE);`,
    `const journal = createIntroPendingJournal(process.env);`,
    `const input = JSON.parse(process.env.INTRO_PENDING_INPUT);`,
    `const result = await journal[process.env.INTRO_PENDING_ACTION](input);`,
    `process.stdout.write(JSON.stringify(result));`,
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: {
      ...process.env,
      ...env,
      INTRO_PENDING_MODULE: MODULE_URL,
      INTRO_PENDING_ACTION: action,
      INTRO_PENDING_INPUT: JSON.stringify(input),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

test('read and no-op calls do not create intro-pending; stage returns its ID and creates private storage', async t => {
  const f = await fixture(t), id = randomUUID();
  assert.deepEqual(await f.journal.list(), []);
  assert.equal(await f.journal.claim(id), null);
  assert.equal(await f.journal.remove(id), false);
  assert.equal(await f.journal.cancel('-10042:42:17'), 0);
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });

  const staged = await f.journal.stage(record(id));
  assert.deepEqual(staged, { id, created: true, status: 'prepared' });
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.directory, `${id}.json`))).mode & 0o777, 0o600);
  assert.equal((await f.journal.list())[0].activeSessionId, 'claude-session-fixture');
  const lockStat = await fs.stat(path.join(f.root, '.intro-pending-transaction.lock.sqlite'));
  assert.equal(lockStat.mode & 0o777, 0o600);
});

test('no-op list/cancel on an existing bot root still does not create the journal directory', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root, { recursive: true });
  assert.deepEqual(await f.journal.list(), []);
  assert.equal(await f.journal.cancel('-10042:42:17'), 0);
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
});

test('stage preserves the exact prompt and captured identity across a new journal instance', async t => {
  const f = await fixture(t), id = randomUUID();
  const prepared = record(id, { prompt: 'Exact\nprepared\0payload\n', sessionId: null,
    activeSessionId: null, updateId: null });
  const first = await f.journal.stage(prepared);
  assert.equal(first.id, id);
  const second = await createIntroPendingJournal(f.env).stage(prepared);
  assert.deepEqual(second, { id, created: false, status: 'prepared' });

  const [saved] = await createIntroPendingJournal(f.env).list();
  assert.equal(saved.prompt, prepared.prompt);
  assert.equal(saved.scope, prepared.scope);
  assert.equal(saved.chatId, prepared.chatId);
  assert.equal(saved.userId, prepared.userId);
  assert.equal(saved.threadId, prepared.threadId);
  assert.equal(saved.incomingMessageId, prepared.incomingMessageId);
  assert.equal(saved.statusId, prepared.statusId);
  assert.equal(saved.updateId, null);
  assert.deepEqual(saved.sourceUpdateIds, [3001, 3002]);
  assert.equal(saved.requireCodex, true);
  assert.equal(saved.sessionId, null);
  assert.equal(saved.activeSessionId, null);
  assert.equal(saved.project, 'alpha');
  assert.equal(saved.epoch, 6);
  assert.equal(saved.profileDir, prepared.profileDir);
  assert.equal(saved.workspace, prepared.workspace);
  assert.equal(saved.cwd, prepared.cwd);
  assert.equal(saved.status, 'prepared');
  assert.equal(Object.hasOwn(saved, 'ctx'), false);
  assert.equal(Object.hasOwn(saved, 'botToken'), false);
});

test('stage is idempotent by ID and never overwrites different input or a started record', async t => {
  const f = await fixture(t), id = randomUUID(), prepared = record(id);
  assert.deepEqual(await f.journal.stage(prepared), { id, created: true, status: 'prepared' });
  await assert.rejects(f.journal.stage(record(id, { prompt: 'different prepared content' })), { code: 'INTRO_PENDING_ID_CONFLICT' });
  await assert.rejects(f.journal.stage(record(id, { activeSessionId: codexSession })), { code: 'INTRO_PENDING_ID_CONFLICT' });

  const started = await f.journal.claim(id);
  assert.equal(started.status, 'started');
  assert.equal(typeof started.startedAt, 'string');
  assert.deepEqual(await f.journal.stage(prepared), { id, created: false, status: 'started' });
  assert.equal((await f.journal.claim(id)), null, 'started records are not claimable again');
  assert.equal((await f.journal.list())[0].prompt, prepared.prompt);
});

test('release returns an unlaunched claim to prepared once, then claim is one-way again', async t => {
  const f = await fixture(t), prepared = record(randomUUID());
  await f.journal.stage(prepared);
  assert.equal(await f.journal.release(prepared.id), false, 'prepared is not a releasable claim');

  assert.equal((await f.journal.claim(prepared.id)).status, 'started');
  assert.equal(await f.journal.release(prepared.id), true);
  const released = (await f.journal.list())[0];
  assert.equal(released.status, 'prepared');
  assert.equal(Object.hasOwn(released, 'startedAt'), false);

  assert.equal((await f.journal.claim(prepared.id)).status, 'started');
  assert.equal(await f.journal.claim(prepared.id), null);
  assert.equal(await f.journal.release(randomUUID()), false);
});

test('claim is one-way; cancellation redacts prepared prompt and leaves started for explicit cleanup', async t => {
  const f = await fixture(t), preparedId = randomUUID(), startedId = randomUUID();
  await f.journal.stage(record(preparedId));
  await f.journal.stage(record(startedId));
  await f.journal.claim(startedId);

  assert.equal(await f.journal.cancel('-10042:42:17'), 1, 'scope cancellation only removes unclaimed prepared work');
  const rows = await f.journal.list();
  const cancelled = rows.find(row => row.id === preparedId);
  const started = rows.find(row => row.id === startedId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(Object.hasOwn(cancelled, 'prompt'), false);
  assert.equal(started.status, 'started');
  assert.equal(started.prompt, record(startedId).prompt);
  assert.deepEqual(await f.journal.stage(record(preparedId)), { id: preparedId, created: false, status: 'cancelled' });
  assert.equal(await f.journal.claim(preparedId), null);
  assert.equal(await f.journal.cancelId(startedId), true, 'caller cancels started after abort');
  assert.equal((await f.journal.list()).find(row => row.id === startedId).status, 'cancelled');
  assert.equal(await f.journal.release(startedId), false, 'cancelled records cannot be released');
  assert.equal(await f.journal.remove(startedId), true, 'caller can remove started/cancelled after handling');
  assert.equal(await f.journal.remove(preparedId), true);
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
});

test('two processes cannot stage duplicates or claim one prepared ID twice', async t => {
  const f = await fixture(t), prepared = record(randomUUID());
  const staged = await Promise.all([
    runChild(f.env, 'stage', prepared),
    runChild(f.env, 'stage', prepared),
  ]);
  assert.equal(staged.filter(result => result.created).length, 1);
  assert.equal(staged.filter(result => !result.created && result.status === 'prepared').length, 1);
  assert.equal((await f.journal.list()).length, 1);

  const claimed = await Promise.all([
    runChild(f.env, 'claim', prepared.id),
    runChild(f.env, 'claim', prepared.id),
  ]);
  assert.equal(claimed.filter(Boolean).length, 1);
  assert.equal(claimed.filter(result => result?.status === 'started').length, 1);
  assert.equal((await f.journal.list())[0].status, 'started');
  assert.equal(await f.journal.claim(prepared.id), null, 'reopening cannot auto-claim started');
});

test('a list racing removal of its final private directory returns an empty list', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.journal.stage(record(id));
  const realpath=fs.realpath;
  let removed=false;
  t.mock.method(fs,'realpath',async value=>{
    if (!removed && value === f.directory) { removed=true; await f.journal.remove(id); }
    return realpath(value);
  });
  assert.deepEqual(await f.journal.list(),[]);
  assert.equal(removed,true);
});

test('a recovered prepared record can be claimed once; a started provider call remains uncertain after reopen', async t => {
  const f = await fixture(t), prepared = record(randomUUID());
  await f.journal.stage(prepared);
  const reopened = createIntroPendingJournal(f.env);
  assert.equal((await reopened.list())[0].prompt, prepared.prompt);
  assert.equal((await reopened.claim(prepared.id)).status, 'started');
  // This checkpoint is written before provider launch; once launch may have occurred,
  // the caller must not call release and recovery must not retry it automatically.
  const afterReopen = createIntroPendingJournal(f.env);
  assert.equal((await afterReopen.list())[0].status, 'started');
  assert.equal(await afterReopen.claim(prepared.id), null);
});

test('the 9 MiB prompt boundary is exact and larger payloads create no record', async t => {
  const f = await fixture(t), id = randomUUID();
  const maximum = 'x'.repeat(9 * 1024 * 1024);
  assert.equal((await f.journal.stage(record(id, { prompt: maximum }))).created, true);
  const before = await f.journal.list();
  await assert.rejects(f.journal.stage(record(randomUUID(), { prompt: maximum + 'x' })), { code: 'INTRO_PENDING_PROMPT_TOO_LARGE' });
  assert.equal((await f.journal.list()).length, before.length);
});

test('malformed identity, extra context/token fields and invalid Codex IDs are rejected before directory creation', async t => {
  const f = await fixture(t);
  const cases = [
    record('not-a-uuid'),
    record(randomUUID(), { sessionId: 'ext:codex:norestart' }),
    { ...record(randomUUID()), ctx: { message: { text: 'fixture' } } },
    { ...record(randomUUID()), botToken: 'synthetic-only' },
    record(randomUUID(), { userId: 0 }),
    record(randomUUID(), { scope: '42:43:0' }),
    record(randomUUID(), { activeSessionId: 'ext:cursor:0299a213-81c0-7800-8aa1-bbab2a035a54' }),
  ];
  for (const value of cases) await assert.rejects(f.journal.stage(value));
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
});

test('symlinked journal directories and record files fail closed without touching the target', async t => {
  const f = await fixture(t), id = randomUUID();
  await fs.mkdir(f.root, { recursive: true });
  const outside = await fs.mkdtemp(path.join(TMP, 'intro-pending-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, f.directory, 'dir');
  await fs.writeFile(path.join(outside, `${id}.json`), 'outside marker');
  await assert.rejects(f.journal.stage(record(id)), { code: 'INTRO_PENDING_UNSAFE_DIRECTORY' });
  assert.equal(await fs.readFile(path.join(outside, `${id}.json`), 'utf8'), 'outside marker');
  await fs.unlink(f.directory);

  await f.journal.stage(record(id));
  await f.journal.remove(id);
  await fs.mkdir(f.directory, { mode: 0o700 });
  await fs.symlink(path.join(outside, `${id}.json`), path.join(f.directory, `${id}.json`));
  await assert.rejects(f.journal.claim(id), { code: 'INTRO_PENDING_UNSAFE_FILE' });
  await assert.rejects(f.journal.list(), { code: 'INTRO_PENDING_UNSAFE_FILE' });
  assert.equal(await fs.readFile(path.join(outside, `${id}.json`), 'utf8'), 'outside marker');
});

test('malformed records and wrong file modes fail closed without exposing stored text', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.journal.stage(record(id));
  const file = path.join(f.directory, `${id}.json`);
  await fs.writeFile(file, JSON.stringify({ id, prompt: 'private synthetic payload' }) + '\n', { mode: 0o600 });
  await assert.rejects(f.journal.list(), error => {
    assert.equal(error.code, 'INTRO_PENDING_CORRUPT_RECORD');
    assert.doesNotMatch(error.message, /private synthetic payload/);
    return true;
  });
  await fs.chmod(file, 0o644);
  await assert.rejects(f.journal.claim(id), { code: 'INTRO_PENDING_UNSAFE_FILE_MODE' });
});

test('temporary files left by interrupted writes are ignored then cleaned on a transition', async t => {
  const f = await fixture(t), prepared = record(randomUUID());
  await f.journal.stage(prepared);
  const temporary = path.join(f.directory, `.tmp-${randomUUID()}.json`);
  await fs.writeFile(temporary, 'partial synthetic write', { mode: 0o600 });
  assert.equal((await f.journal.list()).length, 1);
  await f.journal.claim(prepared.id);
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
});

test('staging repairs directory mode; cleanup removes the private directory only when empty', async t => {
  const f = await fixture(t), prepared = record(randomUUID());
  await f.journal.stage(prepared);
  await fs.chmod(f.directory, 0o755);
  await assert.rejects(f.journal.list(), { code: 'INTRO_PENDING_UNSAFE_DIRECTORY_MODE' });
  assert.equal((await f.journal.stage(prepared)).created, false);
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal(await f.journal.remove(prepared.id), true);
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
});
