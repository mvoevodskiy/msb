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
import { readRecentRuns } from '../src/autonomy/history.mjs';
import { statePath } from '../src/paths.mjs';
import { chat, marker, reminderFixture, scheduledAt, until } from './helpers/reminder-registration-fixture.mjs';

const text = 'Проверить почту <входящие>';
const due = Date.parse(scheduledAt);
const json = value => JSON.stringify(value);

async function profile(t, { rejectAdd = false, foreign = false, rejectEnable = false,
  ambiguousAdd = false, switchAfterAdd = false, fleetStopOnEnable = false, disableAckRunAt = null } = {}) {
  let reply = marker();
  const f = await reminderFixture(t, { engine: 'oc', output: () => ({ ok: true, text: reply, reminderRail: 'oc' }) });
  const config = path.join(f.directory, 'openclaw', 'openclaw.json');
  const bin = path.join(f.home, 'fixture-oc-bin');
  const log = path.join(f.home, 'native-command.jsonl');
  const jobs = path.join(f.home, 'native-jobs.json');
  const runs = path.join(f.home, 'native-runs.json');
  const toggleFailures = path.join(f.home, 'native-toggle-failures.json');
  const other = { id: 'fixture-unrelated', enabled: true, name: 'Другая задача' };
  const reportedPath = foreign ? path.join(f.home, 'unrelated-openclaw.json') : config;
  await Promise.all([path.dirname(config), bin].map(dir => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(config, '{}');
  if (foreign) await fs.writeFile(reportedPath, '{}');
  await fs.writeFile(jobs, json([other]));
  await fs.writeFile(runs, '[]');
  await fs.writeFile(toggleFailures, '[]');
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
    '  jobs.push(job); save();',
    ...(switchAfterAdd ? ['  const file = ' + json(statePath()) + ';',
      '  const state = JSON.parse(fs.readFileSync(file)); state.engine = "cc";',
      '  fs.writeFileSync(file, JSON.stringify(state));'] : []),
    '  if (' + json(ambiguousAdd) + ') process.exit(7);',
    '  output(job);',
    '} else {',
    '  const index = jobs.findIndex(job => job.id === args[2]);',
    '  if (index < 0) process.exit(8);',
    '  if (args[1] === "rm") { jobs.splice(index, 1); save(); output({ok:true,removed:true}); }',
    '  else if (args[1] === "enable" || args[1] === "disable") {',
    '    if (JSON.parse(fs.readFileSync(' + json(toggleFailures) + ')).includes(args[1]+":"+args[2])) process.exit(5);',
    '    if (args[1] === "enable" && ' + json(rejectEnable) + ') process.exit(6);',
    '    jobs[index].enabled = args[1] === "enable"; save();',
    '    const runningAtMs = args[1] === "disable" ? ' + json(disableAckRunAt) + ' : null;',
    '    output(runningAtMs ? {...jobs[index], state:{runningAtMs}} : jobs[index]);',
    ...(fleetStopOnEnable ? ['    if (jobs[index].enabled) fs.writeFileSync(' +
      json(path.join(f.directory, 'remote-config.json')) + ', JSON.stringify({autonomyGlobalStop:true}));'] : []),
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
  async function command(output, userText = 'Проверь мою задачу') {
    reply = output;
    const before = f.edits.length;
    await f.request(userText);
    await until(() => f.edits.slice(before).some(edit => edit.includes('⏱')), 'OpenClaw command did not finish', 12_000);
    return f.edits.slice(before).find(edit => edit.includes('⏱'));
  }
  return { ...f, config, other, jobs: () => read(jobs), writeJobs: rows => fs.writeFile(jobs, json(rows)), calls, command,
    failToggles: commands => fs.writeFile(toggleFailures, json(commands)),
    mapping: () => read(nativeMap), writeMapping: entries => fs.writeFile(nativeMap, json(entries)), runEntries: entries => fs.writeFile(runs, json(entries)),
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
    summary: 'Текст модели, который не должен появиться', usage: { input_tokens: 7, output_tokens: 3 } };
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
  const run = JSON.parse(runs);
  assert.deepEqual([run.tokensIn, run.tokensOut, run.costVisible], [7, 3, false]);
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

for (const problem of ['rejectAdd', 'foreign', 'rejectEnable', 'switchAfterAdd']) {
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

test('an accepted native add without usable stdout is recovered by its unique tag', async t => {
  const f = await profile(t, { ambiguousAdd: true });
  await f.request('Напомни через полчаса проверить почту');
  assert.match(await f.final(), /Ок, поставил/);
  const [action] = await f.records();
  const map = (await f.mapping())[action.id];
  assert.equal(map.tag, action.nativeReminderTag);
  const jobs = await f.jobs();
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], f.other);
  assert.equal(jobs[1].id, map.jobId);
  assert.equal(jobs[1].enabled, true);
  assert.equal((await f.calls()).filter(args => args[1] === 'add').length, 1);
});

test('a lost registration intent is cleaned by tag and leaves the neighboring job', async t => {
  const f = await profile(t);
  await f.request('Напомни через полчаса проверить почту');
  assert.match(await f.final(), /Ок, поставил/);
  const [action] = await f.records();
  const map = await f.mapping();
  delete map[action.id].jobId;
  await f.writeMapping(map);
  await fs.writeFile(f.actionFile, '[]');
  await f.scheduler().tickNow();
  assert.deepEqual(await f.jobs(), [f.other]);
  assert.deepEqual(await f.mapping(), {});
  assert.deepEqual(f.delivered(), []);
});

test('a failed Telegram send leaves a durable retry and only one successful delivery', async t => {
  const f = await profile(t);
  await f.request('Напомни через полчаса проверить почту');
  assert.match(await f.final(), /Ок, поставил/);
  const [action] = await f.records();
  const { jobId } = (await f.mapping())[action.id];
  const sendMessage = f.bot.api.sendMessage;
  let sends = 0;
  f.bot.api.sendMessage = (...args) => {
    if (args[1].startsWith('⏰ ') && ++sends === 1) throw Error('Synthetic Telegram outage');
    return sendMessage(...args);
  };
  await f.runEntries([{ jobId, action: 'finished', status: 'ok', runAtMs: due, ts: due + 20 }]);
  f.setTime(due);
  const first = f.scheduler();
  await first.tickNow();
  const { delivery } = (await f.mapping())[action.id];
  assert.equal(delivery.status, 'pending');
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.text, text);
  assert.equal(delivery.retryAt, due + 60_000);
  assert.equal((await f.records())[0].lastRunAt, scheduledAt);
  const journal = path.join(f.directory, 'autonomy', 'runs.jsonl');
  assert.equal(JSON.parse(await fs.readFile(journal, 'utf8')).detail, 'напоминание поставлено в очередь на доставку');
  assert.deepEqual(f.delivered(), []);
  await first.stop();
  const restarted = f.scheduler();
  f.setTime(delivery.retryAt - 1);
  await restarted.tickNow();
  assert.equal(sends, 1);
  f.setTime(delivery.retryAt);
  await restarted.tickNow();
  await restarted.tickNow();
  assert.equal(sends, 2);
  assert.equal(f.delivered().length, 1);
  assert.deepEqual(await f.mapping(), {});
  assert.equal((await f.records())[0].lastStatus, 'ok');
  const runs = await fs.readFile(path.join(f.directory, 'autonomy', 'runs.jsonl'), 'utf8');
  assert.equal(runs.trim().split('\n').length, 1);
});

test('a fleet pause arriving during native activation fences the job before confirmation', async t => {
  const f = await profile(t, { fleetStopOnEnable: true });
  await f.request('Напомни через полчаса проверить почту');
  assert.match(await f.final(), /Поставил:.*общая пауза сервера/s);
  const [action] = await f.records();
  const entry = (await f.mapping())[action.id];
  assert.equal(entry.pausedBy, 'fleet-stop');
  assert.equal(entry.enabled, false);
  assert.equal((await f.jobs()).find(job => job.id === entry.jobId).enabled, false);
  assert.deepEqual(f.delivered(), []);
});

async function addForPause(f, name) {
  const output = marker({ name, trigger: { kind: 'once', at: '+30m' }, task: { kind: 'reminder', text: 'Текст ' + name } });
  assert.match(await f.command(output, 'Поставь ' + name), /Ок, поставил/);
  const action = (await f.records()).find(row => row.name === name);
  return { action, jobId: (await f.mapping())[action.id].jobId };
}

const jobEnabled = async (f, jobId) => (await f.jobs()).find(row => row.id === jobId).enabled;

test('the owned OpenClaw prompt advertises both pause scopes', async t => {
  await profile(t);
  const guidance = await openClawTaskMaintenancePrompt((await loadState()).state, process.env, 42);
  for (const word of ['[STOP_ALL]', '[RESUME_ALL]', '[PAUSE_TASK:', '[RESUME_TASK:']) assert.ok(guidance.includes(word), word);
});

test('OpenClaw STOP and RESUME leave personally paused and unrelated jobs intact', async t => {
  const f = await profile(t);
  const personal = await addForPause(f, 'Личная');
  const general = await addForPause(f, 'Общая');
  const pause = await f.command('[PAUSE_TASK: ' + personal.action.id + ']', 'Поставь личную на паузу');
  assert.match(pause, /«Личная» на паузе/);
  assert.equal(await jobEnabled(f, personal.jobId), false);
  assert.equal(await jobEnabled(f, general.jobId), true);
  assert.equal((await f.records()).find(row => row.id === personal.action.id).disabledReason, 'owner');

  const stop = await f.command('[STOP_ALL]', 'Останови фоновые задачи');
  assert.match(stop, /снято с расписания задач: 1/);
  assert.ok((await fs.stat(f.stopFile)).isFile());
  assert.equal(await jobEnabled(f, general.jobId), false);
  const paused = await f.mapping();
  assert.equal(paused[personal.action.id].pausedBy, 'owner');
  assert.equal(paused[general.action.id].pausedBy, 'stop');

  const resumed = await f.command('[RESUME_ALL]', 'Верни задачи в работу');
  assert.match(resumed, /задачи снова в работе \(1\)[\s\S]*Общая/);
  assert.doesNotMatch(resumed, /Личная/);
  await assert.rejects(fs.stat(f.stopFile), { code: 'ENOENT' });
  assert.equal(await jobEnabled(f, personal.jobId), false);
  assert.equal(await jobEnabled(f, general.jobId), true);
  assert.deepEqual((await f.jobs()).find(job => job.id === f.other.id), f.other);
});

test('native global pause reports refusal and leaves the owner STOP for reconciliation', async t => {
  const f = await profile(t);
  const failed = await addForPause(f, 'Неподтверждённая');
  const successful = await addForPause(f, 'Останавливаемая');
  await f.failToggles(['disable:' + failed.jobId]);
  const stop = await f.command('[STOP_ALL]', 'Останови фоновые задачи');
  assert.match(stop, /снято с расписания задач: 1/);
  assert.match(stop, /Остановка неполная/i);
  assert.ok((await fs.stat(f.stopFile)).isFile());
  assert.equal(await jobEnabled(f, successful.jobId), false);
  assert.equal(await jobEnabled(f, failed.jobId), true);
  assert.equal((await f.mapping())[failed.action.id].pausedBy, undefined);
  await f.failToggles([]);
  await f.scheduler().tickNow();
  assert.equal(await jobEnabled(f, failed.jobId), false);
});

test('native general resume reports only confirmed jobs when one enable fails', async t => {
  const f = await profile(t);
  const failed = await addForPause(f, 'С отказом');
  const restored = await addForPause(f, 'Готовая');
  assert.match(await f.command('[STOP_ALL]'), /снято с расписания задач: 2/);
  await f.failToggles(['enable:' + failed.jobId]);
  const result = await f.command('[RESUME_ALL]');
  assert.match(result, /задачи снова в работе \(1\)[\s\S]*Готовая/);
  assert.doesNotMatch(result, /• С отказом/);
  assert.match(result, /Не удалось вернуть в расписание движка/);
  assert.equal(await jobEnabled(f, restored.jobId), true);
  assert.equal(await jobEnabled(f, failed.jobId), false);
  assert.equal((await f.mapping())[failed.action.id].pausedBy, 'stop');
});

test('native personal resume under owner and fleet STOP saves intent without enabling the job', async t => {
  const f = await profile(t);
  const { action, jobId } = await addForPause(f, 'Под общей паузой');
  assert.match(await f.command('[PAUSE_TASK: ' + action.id + ']'), /на паузе/);
  const fleet = path.join(f.directory, 'remote-config.json');
  await fs.writeFile(fleet, json({ autonomyGlobalStop: true }));
  await f.command('[STOP_ALL]');
  const enableCount = (await f.calls()).filter(args => args[1] === 'enable').length;
  const personal = await f.command('[RESUME_TASK: ' + action.id + ']');
  assert.match(personal, /включена[\s\S]*общая пауза/i);
  assert.equal((await f.records())[0].enabled, true);
  assert.equal(await jobEnabled(f, jobId), false);
  assert.match(await f.command('[RESUME_ALL]'), /Общая пауза сервера остаётся/);
  assert.equal((await f.calls()).filter(args => args[1] === 'enable').length, enableCount);
  assert.equal(await jobEnabled(f, jobId), false);
  await fs.unlink(fleet);
  await f.scheduler().tickNow();
  assert.equal(await jobEnabled(f, jobId), true);
});

test('personal pause preserves the old local intent and warns if native disable fails', async t => {
  const f = await profile(t);
  const { action, jobId } = await addForPause(f, 'Не снятая');
  await f.failToggles(['disable:' + jobId]);
  const pause = await f.command('[PAUSE_TASK: ' + action.id + ']');
  assert.match(pause, /«Не снятая» на паузе/);
  assert.match(pause, /Не удалось снять с расписания движка/);
  assert.equal((await f.records())[0].disabledReason, 'owner');
  assert.equal(await jobEnabled(f, jobId), true);
  await f.failToggles([]);
  await f.scheduler().tickNow();
  assert.equal(await jobEnabled(f, jobId), false);
  assert.equal((await f.mapping())[action.id].pausedBy, 'owner');
});

test('a missing native job does not inflate the STOP count or erase its terminal run', async t => {
  const f = await profile(t);
  const { action, jobId } = await addForPause(f, 'Уже запущенная');
  await f.writeJobs([f.other]);
  await f.runEntries([{ jobId, action: 'finished', status: 'ok', runAtMs: due }]);
  f.setTime(due);
  const stop = await f.command('[STOP_ALL]');
  assert.match(stop, /снято с расписания задач: 0/);
  assert.doesNotMatch(stop, /Остановка неполная/i);
  assert.equal((await f.mapping())[action.id].jobId, jobId);
  const scheduler = f.scheduler();
  await scheduler.tickNow();
  assert.deepEqual(f.delivered(), []);
  const resume = await f.command('[RESUME_ALL]');
  assert.doesNotMatch(resume, /задачи снова в работе/);
  await scheduler.tickNow();
  assert.equal(f.delivered().length, 1);
  assert.equal((await f.calls()).filter(args => args[1] === 'enable' && args[2] === jobId).length, 1);
});

test('unbound legacy OpenClaw mappings stay untouched and make STOP partial', async t => {
  const f = await profile(t);
  await addForPause(f, 'С привязкой');
  const legacy = { id: 'legacy-unbound', name: 'Прежняя нативная', enabled: true, runner: 'oc',
    trigger: { kind: 'once', at: scheduledAt }, task: { kind: 'reminder', text: 'Старая' } };
  const mapping = { jobId: f.other.id, enabled: true };
  await fs.writeFile(f.actionFile, json([...(await f.records()), legacy]));
  await f.writeMapping({ ...(await f.mapping()), [legacy.id]: mapping });
  assert.match(await f.command('[PAUSE_TASK: ' + legacy.id + ']'), /в этом маршруте пока не подключено/);
  const stop = await f.command('[STOP_ALL]');
  assert.match(stop, /снято с расписания задач: 1/);
  assert.match(stop, /Остановка неполная/i);
  assert.deepEqual((await f.mapping())[legacy.id], mapping);
  assert.deepEqual((await f.records()).find(row => row.id === legacy.id), legacy);
  assert.deepEqual((await f.jobs()).find(job => job.id === f.other.id), f.other);
});

const disabledRun = jobId => ({ jobId, action: 'finished', status: 'error', completionStatus: 'failed',
  error: 'Cron job disabled by operator.', runAtMs: due, ts: due + 20 });

test('an operator-disabled one-shot is spent and never sent after owner RESUME', async t => {
  const f = await profile(t);
  const { action, jobId } = await addForPause(f, 'Прерванная');
  f.setTime(due);
  assert.match(await f.command('[STOP_ALL]'), /снято с расписания задач: 1/);
  await f.runEntries([disabledRun(jobId), disabledRun(jobId)]);
  const reply = await f.command('[RESUME_ALL]');
  assert.doesNotMatch(reply, /задачи снова в работе/);
  await f.scheduler().tickNow();
  await f.scheduler().tickNow();
  assert.deepEqual(f.delivered(), []);
  assert.equal((await f.calls()).filter(args => args[1] === 'enable' && args[2] === jobId).length, 1);
  assert.deepEqual(await f.jobs(), [f.other]);
  assert.equal((await f.records()).find(row => row.id === action.id).lastOutcome, 'stopped');
  const journal = (await fs.readFile(path.join(f.directory, 'autonomy', 'runs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(journal.map(row => [row.nativeJobId, row.status]), [[jobId, 'stopped']]);
  assert.equal((await readRecentRuns()).runs[0].status, 'stopped');
  assert.match(await f.command('[TASK_RUNS: ' + action.id + ']'), /снят стопом/);
});

test('resume waits for a running-at-disable one-shot even while its terminal record is missing', async t => {
  const f = await profile(t, { disableAckRunAt: due });
  const { action, jobId } = await addForPause(f, 'Запись ещё пишется');
  f.setTime(due);
  assert.match(await f.command('[STOP_ALL]'), /снято с расписания задач: 1/);
  // The run started after listing, appeared in the disable ack and left running state.
  await f.runEntries([{ ...disabledRun(jobId), runAtMs: due - 1000 }]);
  assert.doesNotMatch(await f.command('[RESUME_ALL]'), /задачи снова в работе/);
  const scheduler = f.scheduler();
  await scheduler.tickNow();
  assert.equal(await jobEnabled(f, jobId), false);
  assert.deepEqual(f.delivered(), []);
  assert.equal((await f.records()).find(row => row.id === action.id).lastRunAt, undefined);
  await f.runEntries([disabledRun(jobId)]);
  await scheduler.tickNow();
  assert.equal((await f.records()).find(row => row.id === action.id).lastOutcome, 'stopped');
  assert.equal((await f.calls()).filter(args => args[1] === 'enable' && args[2] === jobId).length, 1);
  assert.deepEqual(f.delivered(), []);
});

test('a completed ordinary model error after STOP is delivered once without rearming the one-shot', async t => {
  const f = await profile(t);
  const { action, jobId } = await addForPause(f, 'Обычная ошибка');
  f.setTime(due);
  await f.command('[STOP_ALL]');
  await f.runEntries([{ ...disabledRun(jobId), error: 'Fixture model unavailable' }]);
  assert.doesNotMatch(await f.command('[RESUME_ALL]'), /задачи снова в работе/);
  const scheduler = f.scheduler();
  await scheduler.tickNow();
  await scheduler.tickNow();
  assert.equal((await f.calls()).filter(args => args[1] === 'enable' && args[2] === jobId).length, 1);
  assert.equal((await f.records()).find(row => row.id === action.id).lastOutcome, 'ok');
  assert.deepEqual(f.delivered().map(item => item.text), ['⏰ Текст Обычная ошибка']);
});

test('resume recovers the run time from native state for a previously saved pause', async t => {
  const f = await profile(t);
  const { action, jobId } = await addForPause(f, 'Ранее приостановленная');
  f.setTime(due);
  await f.command('[STOP_ALL]');
  const owned = (await f.jobs()).find(job => job.id === jobId);
  await f.writeJobs([f.other, { ...owned, state: { lastRunAtMs: due } }]);
  assert.doesNotMatch(await f.command('[RESUME_ALL]'), /задачи снова в работе/);
  assert.equal((await f.mapping())[action.id].awaitingRunAtMs, due);
  const scheduler = f.scheduler();
  await scheduler.tickNow();
  assert.equal(await jobEnabled(f, jobId), false);
  await f.runEntries([disabledRun(jobId)]);
  await scheduler.tickNow();
  assert.equal((await f.records()).find(row => row.id === action.id).lastOutcome, 'stopped');
  assert.deepEqual(f.delivered(), []);
});
