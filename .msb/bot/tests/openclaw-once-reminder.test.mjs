/**
 * OpenClaw literal reminder through the [Telegram worker](../src/telegram/bot.mjs)
 * and [scheduler](../src/autonomy/scheduler.mjs), with an isolated Gateway CLI shim.
 * Old readable blob 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11:
 * 15886–15889, 15989–15991, 34323–34365, 34453–34527, 45865–45970.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openClawTaskMaintenancePrompt } from '../src/autonomy/reminder-protocol.mjs';
import { loadState } from '../src/state.mjs';
import { chat, marker, reminderFixture, scheduledAt } from './helpers/reminder-registration-fixture.mjs';

const text = 'Проверить почту <входящие>';
const due = Date.parse(scheduledAt);
const json = value => JSON.stringify(value);

async function profile(t, { rejectAdd = false, foreign = false, rejectEnable = false } = {}) {
  const f = await reminderFixture(t, { engine: 'oc', output: () => ({ ok: true, text: marker(), reminderRail: 'oc' }) });
  const config = path.join(f.directory, 'openclaw', 'openclaw.json');
  const bin = path.join(f.home, 'fixture-oc-bin');
  const log = path.join(f.home, 'native-command.jsonl');
  const jobs = path.join(f.home, 'native-jobs.json');
  const runs = path.join(f.home, 'native-runs.json');
  const other = { id: 'fixture-unrelated', enabled: true, name: 'Другая задача' };
  const reportedPath = foreign ? path.join(f.home, 'unrelated-openclaw.json') : config;
  await Promise.all([path.dirname(config), bin].map(dir => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(config, '{}');
  if (foreign) await fs.writeFile(reportedPath, '{}');
  await fs.writeFile(jobs, json([other]));
  await fs.writeFile(runs, '[]');
  const argvLog = path.join(bin, 'openclaw');
  await fs.writeFile(argvLog, '#!' + process.execPath + '\n' + [
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'const output = data => console.log(JSON.stringify(data));',
    'const jobs = JSON.parse(fs.readFileSync(' + json(jobs) + '));',
    'const save = () => fs.writeFileSync(' + json(jobs) + ', JSON.stringify(jobs));',
    'fs.appendFileSync(' + json(log) + ', JSON.stringify(args) + "\\n");',
    'const field = name => args[args.indexOf(name) + 1];',
    'if (args[0] === "config") output("local");',
    'else if (args[0] === "gateway") output({path:' + json(reportedPath) + ', config:{gateway:{mode:"local"}}});',
    'else if (args[0] !== "cron") process.exit(9);',
    'else if (args[1] === "list") output({jobs});',
    'else if (args[1] === "runs") output({entries:JSON.parse(fs.readFileSync(' + json(runs) + '))});',
    'else if (args[1] === "add") {',
    '  if (' + json(rejectAdd) + ') process.exit(7);',
    '  const job = {id:"fixture-native-"+jobs.length, name:field("--name"), description:field("--description"),',
    '    enabled:!args.includes("--disabled"), schedule:{kind:"at",at:field("--at")}};',
    '  jobs.push(job); save(); output(job);',
    '} else {',
    '  const index = jobs.findIndex(job => job.id === args[2]);',
    '  if (index < 0) process.exit(8);',
    '  if (args[1] === "rm") { jobs.splice(index, 1); save(); output({ok:true,removed:true}); }',
    '  else if (args[1] === "enable" || args[1] === "disable") {',
    '    if (args[1] === "enable" && ' + json(rejectEnable) + ') process.exit(6);',
    '    jobs[index].enabled = args[1] === "enable"; save(); output(jobs[index]);',
    '  } else process.exit(9);',
    '}',
  ].join('\n'), { mode: 0o700 });
  Object.assign(process.env, { OPENCLAW_STATE_DIR: path.dirname(config), OPENCLAW_CONFIG_PATH: config,
    PATH: bin + path.delimiter + process.env.PATH });
  for (const key of ['OPENCLAW_GATEWAY_URL', 'OPENCLAW_INCLUDE_ROOTS', 'OPENCLAW_PROFILE']) delete process.env[key];
  const nativeMap = path.join(f.directory, 'autonomy', 'cron-jobs.json');
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const calls = async () => (await fs.readFile(log, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { ...f, config, other, jobs: () => read(jobs), calls,
    mapping: () => read(nativeMap), runEntries: entries => fs.writeFile(runs, json(entries)),
    stopFile: path.join(f.directory, 'autonomy', 'STOP') };
}

test('OpenClaw owner guidance advertises the old literal one-shot marker', async t => {
  const f = await profile(t);
  const { state } = await loadState();
  assert.match(await openClawTaskMaintenancePrompt(state, process.env, 42), /\[SCHEDULE_TASK\].*"kind":"once".*"kind":"reminder"/);
  assert.deepEqual(await f.jobs(), [f.other]);
});

test('OpenClaw once waits for its native terminal event and delivers the stored text to the origin topic', async t => {
  const f = await profile(t);
  await f.request('Напомни через полчаса проверить почту');
  assert.match(await f.final(), /Ок, поставил/);
  const [action] = await f.records();
  assert.equal(action.runner, 'oc');
  assert.deepEqual(action.trigger, { kind: 'once', at: scheduledAt });
  assert.deepEqual(action.origin, { chatId: chat, threadId: 17, messageId: 43 });
  const map = await f.mapping();
  const jobId = map[action.id].jobId;
  const calls = await f.calls();
  const add = calls.find(args => args[0] === 'cron' && args[1] === 'add');
  for (const arg of ['--disabled', '--at', scheduledAt, '--delete-after-run', '--session', 'isolated',
    '--light-context', '--no-deliver', '--tools', 'read']) assert.ok(add.includes(arg), arg);
  assert.ok(!calls.some(args => args[0] === 'cron' && args[1] === 'run'));
  assert.equal((await f.jobs()).find(job => job.id === jobId).enabled, true);

  const first = f.scheduler();
  await f.runEntries([{ jobId: f.other.id, action: 'finished', status: 'ok', runAtMs: due }]);
  f.setTime(due);
  await first.tickNow();
  assert.deepEqual(f.delivered(), []);
  const finish = { jobId, action: 'finished', status: 'error', runAtMs: due, ts: due + 20,
    summary: 'Текст модели, который не должен появиться' };
  await f.runEntries([finish, finish]);
  await first.tickNow();
  await first.stop();
  await f.scheduler().tickNow();
  assert.deepEqual(f.delivered().map(({ destination, text: sent, options }) => [destination, sent, options]), [
    [chat, '⏰ ' + text, { message_thread_id: 17, reply_parameters: { message_id: 43, allow_sending_without_reply: true } }],
  ]);
  const [spent] = await f.records();
  assert.equal(spent.lastStatus, 'ok');
  assert.ok(spent.lastRunAt);
  const runs = await fs.readFile(path.join(f.directory, 'autonomy', 'runs.jsonl'), 'utf8');
  assert.equal(runs.trim().split('\n').length, 1);
});

test('OpenClaw once saved during STOP stays native-disabled until the pause is lifted', async t => {
  const f = await profile(t);
  await fs.mkdir(path.dirname(f.stopFile), { recursive: true });
  await fs.writeFile(f.stopFile, 'owner pause');
  await f.request('Напомни через полчаса проверить почту');
  assert.match(await f.final(), /Поставил:.*Но сейчас задачи на паузе/s);
  const [action] = await f.records();
  const entry = (await f.mapping())[action.id];
  assert.equal(entry.pausedBy, 'stop');
  const scheduler = f.scheduler();
  await scheduler.tickNow();
  assert.equal((await f.jobs()).find(job => job.id === entry.jobId).enabled, false);
  await fs.unlink(f.stopFile);
  await scheduler.tickNow();
  assert.equal((await f.jobs()).find(job => job.id === entry.jobId).enabled, true);
  assert.deepEqual(f.delivered(), []);
});

for (const problem of ['rejectAdd', 'foreign', 'rejectEnable']) {
  test('OpenClaw once does not publish an action when ' + problem, async t => {
    const f = await profile(t, { [problem]: true });
    const existing = '[\n  {"id":"existing"}\n]\n';
    await fs.writeFile(f.actionFile, existing);
    await f.request('Напомни через полчаса проверить почту');
    assert.match(await f.final(), /Не удалось поставить задачу/);
    assert.doesNotMatch(await f.final(), /Ок, поставил/);
    assert.deepEqual(await f.jobs(), [f.other]);
    assert.deepEqual(await f.records(), JSON.parse(existing));
    assert.ok(!(await f.mapping().catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return {};
    }))['conv-reminder-2026-11-08T10-00-00-000Z']);
    if (problem === 'foreign') {
      assert.ok(!(await f.calls()).some(args => args[0] === 'cron' && args[1] === 'add'));
      assert.equal(await fs.readFile(f.actionFile, 'utf8'), existing);
    }
  });
}
