// Old blob 73aa9e7e:3778-3863, 109809-109879 and 110222-110249.
// Accepted Codex direct wake/notice: ab705acaace5f6968213ac71dd323ecc5e954bb1.
// Real ingress/inbox with synthetic HOME and fake Telegram/model only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers/menu-fixture.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { readEnvMap } from '../src/env/store.mjs';
import { createIntroPendingJournal } from '../src/agent/intro-pending.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const codexPauseNotice = /Codex на паузе\./;
async function until(predicate, label) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await wait(5); }
  throw Error(`Timed out: ${label}`);
}
async function sleepMarker() {
  const dir = path.join(process.env.MSB_RUNTIME_ROOT, 'engine');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const marker = path.join(dir, 'sleep.default');
  await fs.writeFile(marker, 'fixture');
  return marker;
}
async function systemWakeFixture(t, runTurn) {
  const f = await fixture(t, runTurn);
  const { state } = await loadState();
  // Codex wakes locally. Exercise the unchanged shared fallback with Cursor selected.
  await saveState({ ...state, extAuthBypass: 'cursor', ccSessionId: 'ext:cursor:0199a213-81c0-7800-8aa1-bbab2a035a53' });
  const providers = JSON.parse(await fs.readFile(f.storeFile, 'utf8'));
  await fs.writeFile(f.storeFile, JSON.stringify({ ...providers, active: 'cursor' }));
  return f;
}
async function stageIntro(f, overrides = {}) {
  const state = (await loadState()).state;
  const journal = createIntroPendingJournal();
  const id = randomUUID();
  await journal.stage({
    id, scope: '42:42:0', prompt: 'synthetic ninth message', chatId: 42, userId: 42,
    incomingMessageId: 123, statusId: 456, requireCodex: true,
    sessionId: state.ccSessionId, activeSessionId: state.ccSessionId, project: null, epoch: 0,
    profileDir: path.join(f.home, '.codex'), workspace: f.workspace, cwd: await fs.realpath(f.workspace),
    ...overrides,
  });
  return { journal, id };
}

test('sleep blocks model and media, while /settings and open settings forms work', async t => {
  let turns = 0, downloads = 0, clock = 1;
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'unexpected' }; }, { now: () => clock });
  f.bot.api.getFile = async () => { downloads++; throw Error('unexpected download'); };
  await sleepMarker();
  await f.message('обычный запрос');
  assert.match(f.messages.at(-1), codexPauseNotice);
  const wake = f.messageOptions.at(-1).reply_markup.inline_keyboard.flat().find(b => b.callback_data === 'eng:wake');
  assert.equal(wake?.text, '🔀 Переключить');
  clock += 31_000;
  await f.message('/start');
  for (const media of [{ voice: { file_id: 'fixture', duration: 1 } },
    { document: { file_id: 'fixture', file_name: 'fixture.txt' } }]) {
    clock += 31_000;
    await f.bot.handleUpdate({ message: { message_id: 4, from: { id: 42 }, chat: { id: 42 }, ...media } });
  }
  await wait(20);
  assert.equal(turns, 0);
  assert.equal(downloads, 0);
  clock += 31_000;
  await f.message('/settings');
  assert.ok(f.messages.some(text => /Настройки/.test(text)));
  await f.callback('settings:env:quick:TEST_SLEEP_KEY');
  await f.message('synthetic-value');
  await f.callback('settings:env:skip-comment', 42, { messageId: f.messages.length });
  assert.equal((await readEnvMap()).map.get('TEST_SLEEP_KEY'), 'synthetic-value');
});

test('wake resumes the existing Codex provider and session', async t => {
  let turns = 0;
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'fixture-answer' }; });
  const before = (await loadState()).state;
  const marker = await sleepMarker();
  await f.message('запрос во сне');
  await f.callback('eng:wake');
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
  const after = (await loadState()).state;
  assert.equal(after.extAuthBypass, before.extAuthBypass);
  assert.equal(after.ccSessionId, before.ccSessionId);
  await f.message('после пробуждения');
  await until(() => turns === 1, 'the resumed turn');
});

test('an already queued request is not run when sleep starts before admission', async t => {
  let turns = 0, release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async () => {
    turns++;
    if (turns === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return { ok: true, text: 'fixture-answer' };
  });
  await f.message('первый');
  await entered;
  await f.message('в очереди');
  assert.ok(f.messages.includes('⏳ в очереди'));
  await sleepMarker();
  release();
  await until(() => f.messages.some(text => codexPauseNotice.test(text)), 'sleep notice for queued input');
  assert.equal(turns, 1);
  assert.ok(f.deleted.length > 0, 'the queued status is removed');
  await f.callback('eng:wake');
  await f.message('после пробуждения');
  await until(() => turns === 2, 'the later admitted input');
});

test('sleep notices are throttled but a message resembling a key is deleted and acknowledged', async t => {
  let clock = 1;
  const f = await fixture(t, undefined, { now: () => clock });
  await sleepMarker();
  await f.message('первое');
  await f.message('второе');
  assert.equal(f.messages.filter(text => codexPauseNotice.test(text)).length, 1);
  await f.message('sk-ant-synthetic-only');
  assert.ok(f.deleted.includes(99));
  assert.match(f.messages.at(-1), /Сообщение с ключом удалил/);
  assert.ok(!f.messages.some(text => text.includes('sk-ant-synthetic-only')));
  clock += 31_000;
  await f.message('следующее');
  assert.equal(f.messages.filter(text => codexPauseNotice.test(text)).length, 3);
});

test('key deletion failure is reported and a blocked callback is acknowledged', async t => {
  const f = await fixture(t);
  await sleepMarker();
  f.bot.api.deleteMessage = async () => { throw Error('fixture denial'); };
  await f.message('sk-ant-synthetic-only');
  assert.match(f.messages.at(-1), /Удали сообщение с ключом из чата сам/);
  await f.callback('menu:agent');
  assert.ok(f.callbackAnswers.length > 0);
  assert.equal(f.edits.length, 0);
});

test('an already open overlay connection form accepts its input during sleep', async t => {
  const f = await fixture(t);
  await sleepMarker();
  await f.callback('settings:auth:openrouter');
  assert.match(f.edits.at(-1), /ключ/);
  await f.message('synthetic-key-value');
  assert.match(f.messages.at(-1), /base URL API/);
  await f.callback('settings:back');
});

test('a scheduled turn admitted during sleep is skipped silently', async t => {
  let turns = 0;
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'unexpected' }; });
  await sleepMarker();
  const commit = f.bot[Symbol.for('msb.scheduledTurns')].reserve({ chatId: 42, userId: 42, text: 'synthetic timer' });
  assert.equal(typeof commit, 'function');
  commit(true);
  await wait(40);
  assert.equal(turns, 0);
  assert.ok(!f.messages.some(text => codexPauseNotice.test(text)));
});

test('wake failure keeps the marker and the selected provider', async t => {
  const f = await fixture(t);
  const dir = path.join(process.env.MSB_RUNTIME_ROOT, 'engine', 'sleep.default');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'keep'), 'fixture');
  const before = (await loadState()).state;
  await f.callback('eng:wake');
  assert.match(f.edits.at(-1), /Не получилось переключить/);
  assert.equal(await fs.readFile(path.join(dir, 'keep'), 'utf8'), 'fixture');
  const after = (await loadState()).state;
  assert.equal(after.extAuthBypass, before.extAuthBypass);
  assert.equal(after.ccSessionId, before.ccSessionId);
});

test('Telegram wake falls back to the real request publisher and resumes the selected Cursor session after an OK result', async t => {
  let turns = 0, request, result;
  const f = await systemWakeFixture(t, async () => { turns++; return { ok: true, text: 'fixture-answer' }; });
  const before = (await loadState()).state;
  const marker = await sleepMarker();
  const original = { readFile: fs.readFile, unlink: fs.unlink, link: fs.link };
  let failLocal = true;
  fs.readFile = async (file, ...args) => String(file) === '/run/msb-engine/state.json'
    ? JSON.stringify({ helper: 'msb-engine', host_ready: true, actions: { client: ['enable-msb'] },
      requests: result ? { [request.id]: result } : {} }) : original.readFile(file, ...args);
  fs.unlink = async (file, ...args) => {
    if (String(file) === marker && failLocal) { failLocal = false; throw Object.assign(Error('fixture'), { code: 'EACCES' }); }
    return original.unlink(file, ...args);
  };
  fs.link = async (source, destination) => {
    await original.link(source, destination);
    if (String(destination) !== path.join(process.env.MSB_RUNTIME_ROOT, 'engine', 'request')) return;
    request = JSON.parse(await original.readFile(source, 'utf8'));
    await original.unlink(destination); // synthetic system worker claims the request
    await original.unlink(marker);
    result = { id: request.id, result: 'done', code: 'OK' };
  };
  t.after(() => Object.assign(fs, original));
  await f.callback('eng:wake');
  assert.equal(request.action, 'enable-msb');
  assert.equal(request.bot_id, 'default');
  assert.match(request.sleep_revision, /^\d+:\d+:\d+$/);
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
  const after = (await loadState()).state;
  assert.equal(after.extAuthBypass, before.extAuthBypass);
  assert.equal(after.ccSessionId, before.ccSessionId);
  await f.message('после системного пробуждения');
  await until(() => turns === 1, 'the resumed turn');
});

test('a later sleep before the system consumes wake wins over the older request', async t => {
  const f = await systemWakeFixture(t);
  const marker = await sleepMarker();
  const original = { readFile: fs.readFile, unlink: fs.unlink, link: fs.link };
  let failLocal = true, request, result;
  fs.readFile = async (file, ...args) => String(file) === '/run/msb-engine/state.json'
    ? JSON.stringify({ helper: 'msb-engine', host_ready: true, actions: { client: ['enable-msb'] },
      requests: result ? { [request.id]: result } : {} }) : original.readFile(file, ...args);
  fs.unlink = async (file, ...args) => {
    if (String(file) === marker && failLocal) { failLocal = false; throw Object.assign(Error('fixture'), { code: 'EACCES' }); }
    return original.unlink(file, ...args);
  };
  fs.link = async (source, destination) => {
    await original.link(source, destination);
    if (String(destination) !== path.join(process.env.MSB_RUNTIME_ROOT, 'engine', 'request')) return;
    request = JSON.parse(await original.readFile(source, 'utf8'));
    await original.unlink(destination);
    await original.unlink(marker);
    await fs.writeFile(marker, 'later sleep');
    const info = await fs.lstat(marker, { bigint: true });
    const revision = `${info.dev}:${info.ino}:${info.ctimeNs}`;
    if (request.sleep_revision === revision) await original.unlink(marker);
    result = { id: request.id, result: 'refused', code: 'BUSY' };
  };
  t.after(() => Object.assign(fs, original));
  await f.callback('eng:wake');
  assert.equal(await fs.readFile(marker, 'utf8'), 'later sleep');
  assert.match(f.edits.at(-1), /Не получилось переключить/);
});

test('Node marker revisions are compared by the real Python system worker', async t => {
  await fixture(t);
  const marker = await sleepMarker();
  const info = await fs.lstat(marker, { bigint: true });
  const old = `${info.dev}:${info.ino}:${info.ctimeNs}`;
  const newer = `${marker}.replacement`;
  await fs.writeFile(newer, 'later sleep');
  await fs.rename(newer, marker);
  const script = fileURLToPath(new URL('../../../usr-local-lib/msb-engine/client_markers.py', import.meta.url));
  const physicalMarker = await fs.realpath(marker); // macOS /var is a symlink
  const run = revision => new Promise((resolve, reject) => {
    const child = spawn('python3', ['-IS', script, physicalMarker, 'compare-remove', revision], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  assert.equal(await run(old), 3);
  assert.equal(await fs.readFile(marker, 'utf8'), 'later sleep');
  const current = await fs.lstat(marker, { bigint: true });
  assert.equal(await run(`${current.dev}:${current.ino}:${current.ctimeNs}`), 0);
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
});

test('a new sleep marker after the helper wake is not erased by the older callback', async t => {
  const f = await systemWakeFixture(t);
  const marker = await sleepMarker();
  const original = { readFile: fs.readFile, unlink: fs.unlink, link: fs.link };
  let failLocal = true, request, result;
  fs.readFile = async (file, ...args) => String(file) === '/run/msb-engine/state.json'
    ? JSON.stringify({ helper: 'msb-engine', host_ready: true, actions: { client: ['enable-msb'] },
      requests: result ? { [request.id]: result } : {} }) : original.readFile(file, ...args);
  fs.unlink = async (file, ...args) => {
    if (String(file) === marker && failLocal) { failLocal = false; throw Object.assign(Error('fixture'), { code: 'EACCES' }); }
    return original.unlink(file, ...args);
  };
  fs.link = async (source, destination) => {
    await original.link(source, destination);
    if (String(destination) !== path.join(process.env.MSB_RUNTIME_ROOT, 'engine', 'request')) return;
    request = JSON.parse(await original.readFile(source, 'utf8'));
    await original.unlink(destination);
    await original.unlink(marker); // the helper wakes the first sleep
    await fs.writeFile(marker, 'later sleep'); // a subsequent system action puts it back
    result = { id: request.id, result: 'done', code: 'OK' };
  };
  t.after(() => Object.assign(fs, original));
  await f.callback('eng:wake');
  assert.equal(await fs.readFile(marker, 'utf8'), 'later sleep');
  assert.match(f.edits.at(-1), /Не получилось переключить/);
});

test('an unreadable sleep marker is not mistaken for an awake bot', async t => {
  let turns = 0;
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'unexpected' }; });
  const marker = await sleepMarker();
  const original = fs.lstat;
  fs.lstat = async (file, ...args) => String(file) === marker
    ? Promise.reject(Object.assign(Error('fixture'), { code: 'EACCES' })) : original(file, ...args);
  t.after(() => { fs.lstat = original; });
  await f.message('не запускать');
  await f.callback('eng:wake');
  assert.equal(turns, 0);
  assert.match(f.edits.at(-1), /Не получилось переключить/);
  assert.equal(await fs.readFile(marker, 'utf8'), 'fixture');
});

test('known removed OpenClaw clears a stale sleep marker; unknown status does not', async t => {
  let turns = 0;
  const f = await systemWakeFixture(t, async () => { turns++; return { ok: true, text: 'fixture-answer' }; });
  const marker = await sleepMarker();
  const original = fs.readFile;
  let snapshot = {};
  fs.readFile = async (file, ...args) => String(file) === '/run/msb-engine/state.json'
    ? JSON.stringify(snapshot) : original(file, ...args);
  t.after(() => { fs.readFile = original; });
  assert.equal(await f.bot[Symbol.for('msb.engineSleep')].sleeping(), true);
  assert.equal(await fs.readFile(marker, 'utf8'), 'fixture');
  snapshot = { at: new Date(Date.now() + 2000).toISOString(),
    openclaw: { installed: false, enabled: false } };
  await f.message('продолжение после удаления');
  await until(() => turns === 1, 'the woken turn');
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
});

test('an older OpenClaw snapshot cannot cancel a newly written sleep marker', async t => {
  let turns = 0;
  const f = await systemWakeFixture(t, async () => { turns++; return { ok: true, text: 'unexpected' }; });
  const marker = await sleepMarker();
  const original = fs.readFile;
  fs.readFile = async (file, ...args) => String(file) === '/run/msb-engine/state.json'
    ? JSON.stringify({ at: new Date(Date.now() - 10_000).toISOString(),
      openclaw: { installed: false, enabled: false } }) : original(file, ...args);
  t.after(() => { fs.readFile = original; });
  await f.message('не буди по старому состоянию');
  assert.equal(turns, 0);
  assert.equal(await fs.stat(marker).then(() => true, () => false), true);
  assert.match(f.messages.at(-1), /Сейчас работает OpenClaw/);
});

test('auto-wake cannot erase a later sleep written by the Python system component', async t => {
  const f = await systemWakeFixture(t);
  const marker = await sleepMarker();
  const old = new Date(Date.now() - 5000);
  await fs.utimes(marker, old, old);
  const snapshotAt = new Date().toISOString();
  const controller = f.bot[Symbol.for('msb.engineSleep')];
  let release, readingStarted = false;
  const gate = new Promise(resolve => { release = resolve; });
  const original = fs.readFile;
  fs.readFile = async (file, ...args) => {
    if (String(file) !== '/run/msb-engine/state.json') return original(file, ...args);
    readingStarted = true;
    await gate;
    return JSON.stringify({ at: snapshotAt,
      openclaw: { installed: false, enabled: false } });
  };
  t.after(() => { fs.readFile = original; release(); });
  const sleepCheck = controller.sleeping();
  await until(() => readingStarted, 'the engine snapshot read');
  const script = fileURLToPath(new URL('../../../usr-local-lib/msb-engine/client_markers.py', import.meta.url));
  const code = `
import importlib.util, sqlite3, sys
spec = importlib.util.spec_from_file_location('client_markers', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
connect = sqlite3.connect
class Wrapped:
    def __init__(self, db): self.db = db
    def execute(self, sql):
        if sql == 'BEGIN IMMEDIATE': print('LOCK_ATTEMPT', flush=True)
        return self.db.execute(sql)
    def close(self): self.db.close()
module.sqlite3.connect = lambda *a, **kw: Wrapped(connect(*a, **kw))
module.change(sys.argv[2], b'newer-sleep')
`;
  const child = spawn('python3', ['-I', '-S', '-u', '-c', code, script, await fs.realpath(marker)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`writer ${code}/${signal}: ${errors}`)));
  });
  await until(() => output.includes('LOCK_ATTEMPT'), 'Python writer reaching the lock');
  await wait(50);
  assert.equal(child.exitCode, null, 'writer must wait while the older snapshot is evaluated');
  release();
  assert.equal(await sleepCheck, false);
  await finished;
  assert.equal(await fs.readFile(marker, 'utf8'), 'newer-sleep');
});

test('a prepared introduction handoff remains private and resumes only after wake', async t => {
  let turns = 0;
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'fixture-answer' }; });
  const marker = await sleepMarker();
  const { journal, id } = await stageIntro(f);
  await f.bot.start();
  await wait(30);
  assert.equal(turns, 0);
  assert.equal((await journal.list()).find(record => record.id === id)?.status, 'prepared');
  assert.ok(!f.deleted.includes(456));
  await f.callback('eng:wake');
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
  await until(() => turns === 1, 'prepared introduction recovery after wake');
});

test('waking while a recovered handoff is leaving the sleep gate does not strand it', async t => {
  let turns = 0, release, blocked;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { blocked = resolve; });
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'fixture-answer' }; });
  await stageIntro(f);
  const controller = f.bot[Symbol.for('msb.engineSleep')];
  const queued = controller.queued;
  let first = true;
  controller.queued = async entry => {
    if (entry.recovered && first) {
      first = false;
      await sleepMarker();
      const result = await queued(entry);
      blocked();
      await gate;
      return result;
    }
    return queued(entry);
  };
  await f.bot.start();
  await reached;
  await f.callback('eng:wake');
  release();
  await until(() => turns === 1, 'handoff after the wake/queue race');
});

test('uncertain introduction is not notified or removed until wake', async t => {
  let turns = 0;
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'unexpected' }; });
  const { journal, id } = await stageIntro(f);
  await journal.claim(id);
  await sleepMarker();
  await f.bot.start();
  await wait(30);
  assert.equal((await journal.list()).find(record => record.id === id)?.status, 'started');
  assert.equal(f.edits.length, 0);
  await f.callback('eng:wake');
  assert.ok(f.edits.some(text => /не удалось определить/.test(text)));
  assert.equal((await journal.list()).some(record => record.id === id), false);
  assert.equal(turns, 0);
});

test('wake retries recovery that was already deciding to defer for sleep', async t => {
  let turns = 0, release, blocked;
  const gate = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { blocked = resolve; });
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'fixture-answer' }; });
  await stageIntro(f);
  const marker = await sleepMarker();
  const controller = f.bot[Symbol.for('msb.engineSleep')];
  const sleeping = controller.sleeping;
  let first = true;
  controller.sleeping = async options => {
    const result = await sleeping(options);
    if (first && options?.resumeOnWake === false && result) {
      first = false;
      blocked();
      await gate;
    }
    return result;
  };
  const starting = f.bot.start();
  await reached;
  const waking = f.callback('eng:wake');
  await until(async () => !await fs.stat(marker).then(() => true, () => false), 'marker removal');
  release();
  await Promise.all([starting, waking]);
  await until(() => turns === 1, 'fresh recovery after deferred recovery retires');
});
