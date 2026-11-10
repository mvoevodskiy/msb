/**
 * [Telegram marker](../../src/telegram/reminder-markers.mjs) → real OpenClaw
 * cron → [scheduler](../../src/autonomy/scheduler.mjs) → synthetic Telegram.
 * Network-none Docker command in [the contract](../reference/parity-autonomy-contract.txt).
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { processReminderMarkers } from '../../src/telegram/reminder-markers.mjs';
import { processPauseMarkers } from '../../src/telegram/pause-markers.mjs';
import { processTaskControlMarkers } from '../../src/telegram/task-control-markers.mjs';
import { startScheduler } from '../../src/autonomy/scheduler.mjs';
import { readNativeJobMap, readSavedActionRecords } from '../../src/autonomy/reminder-store.mjs';
import { readSavedActionRunTail } from '../../src/autonomy/reminder-runs.mjs';
import { saveState } from '../../src/state.mjs';

const [cli, mode] = process.argv.slice(2);
assert.ok(path.isAbsolute(cli) && (mode === undefined || mode === 'pause'));
const execute = promisify(execFile);
const root = await fs.mkdtemp('/tmp/oc-once-product-');
const bin = path.join(root, 'bin');
const processes = [];
const reminder = 'Напомни <буквальный текст>';
const modelSummary = 'Native model response deliberately differs';
let modelCalls = 0;
const model = http.createServer(async (req, res) => {
  for await (const chunk of req) {}
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return res.writeHead(404).end();
  modelCalls++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [delta, finish_reason] of [[{ role: 'assistant' }, null], [{ content: modelSummary }, null], [{}, 'stop']]) {
    const chunk = { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason }] };
    res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
});

async function availablePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startGateway(id) {
  const home = path.join(root, id), botRoot = path.join(home, '.iia', 'bots', 'default');
  const native = path.join(botRoot, 'openclaw'), config = path.join(native, 'openclaw.json');
  const workspace = path.join(home, 'workspace');
  await Promise.all([native, workspace].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  const port = await availablePort();
  const env = { HOME: home, PATH: bin + ':/usr/local/bin:/usr/bin:/bin', CI: '1',
    OPENCLAW_OFFLINE: '1', OPENCLAW_NO_AUTO_UPDATE: '1', OPENCLAW_HIDE_BANNER: '1', OPENCLAW_SUPPRESS_NOTES: '1',
    OPENCLAW_STATE_DIR: native, OPENCLAW_CONFIG_PATH: config, MSB_RUNTIME_PROFILE: 'jar1',
    MSB_RUNTIME_ROOT: path.join(home, '.iia'), MSB_BOT_ID: 'default', AUTONOMY_ENABLED: '1' };
  await fs.writeFile(config, JSON.stringify({
    gateway: { mode: 'local', bind: 'loopback', port, controlUi: { enabled: false },
      auth: { mode: 'token', token: 'synthetic-once-gateway-' + id } },
    discovery: { mdns: { mode: 'off' } },
    agents: { defaults: { workspace, model: { primary: 'fixture/fixture-model' } } },
    models: { mode: 'merge', providers: { fixture: { baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1',
      apiKey: 'synthetic-model-key', api: 'openai-completions',
      models: [{ id: 'fixture-model', name: 'Synthetic model', reasoning: false, input: ['text'],
        contextWindow: 131072, maxTokens: 4096 }] } } },
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [cli, 'gateway', 'run', '--port', String(port)], {
    env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'close');
  processes.push({ child, exit });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', part => { log = (log + part).slice(-4000); });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      if ((await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(500) })).ok) {
        const run = async (...args) => {
          const { stdout } = await execute(process.execPath, [cli, ...args], { env, cwd: workspace, timeout: 20_000 });
          return JSON.parse(stdout);
        };
        return { env, config, run };
      }
    } catch {}
    await delay(150);
  }
  throw Error('Gateway did not start: ' + log);
}

const stableJobs = jobs => jobs.map(({ id, name, enabled, schedule }) => ({ id, name, enabled, schedule }))
  .sort((left, right) => left.id.localeCompare(right.id));

let scheduler;
try {
  await fs.mkdir(bin, { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'openclaw'), '#!/bin/sh\nexec ' + process.execPath + ' ' + cli + ' "$@"\n', { mode: 0o700 });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const [primary, other] = await Promise.all([startGateway('primary'), startGateway('other')]);
  const list = profile => profile.run('cron', 'list', '--all', '--json').then(result => stableJobs(result.jobs));
  const before = await Promise.all([list(primary), list(other)]);
  const ownerChat = -100777, origin = -100321;
  const stateFile = await saveState({ engine: 'oc', userId: 42, chatId: ownerChat, timezone: 'Europe/Moscow',
    ccSessionId: 'fixture-claude-session' }, primary.env);
  const protectedFiles = [primary.config, other.config, stateFile];
  const protectedBytes = () => Promise.all(protectedFiles.map(file => fs.readFile(file)));
  const snapshot = await protectedBytes();
  Object.assign(process.env, primary.env);

  const now = Date.now();
  const at = new Date(now + (mode === 'pause' ? 40_000 : 25_000)).toISOString();
  const input = { name: 'Проверяемая', trigger: { kind: 'once', at }, task: { kind: 'reminder', text: reminder } };
  const context = () => ({ ownerId: 42, rail: 'oc', ok: true, chatId: origin, threadId: 17, messageId: 43,
    now: Date.now(), timezone: 'Europe/Moscow', openClawProfile: primary.config });
  const schedule = value => processReminderMarkers('[SCHEDULE_TASK]' + JSON.stringify(value) + '[/SCHEDULE_TASK]', context());
  const response = await schedule(input);
  assert.match(response, /Ок, поставил/);
  const { records: [action] } = await readSavedActionRecords();
  const entry = (await readNativeJobMap())[action.id];
  assert.ok(entry.jobId && entry.enabled && entry.tag === action.nativeReminderTag);
  assert.equal(action.runner, 'oc');
  assert.equal(modelCalls, 0);
  assert.deepEqual(await list(other), before[1]);

  let personalEntry;
  if (mode === 'pause') {
    const personal = { ...input, name: 'Личная', trigger: { kind: 'once', at: new Date(now + 120_000).toISOString() } };
    assert.match(await schedule(personal), /Ок, поставил/);
    const personalAction = (await readSavedActionRecords()).records.find(row => row.name === personal.name);
    personalEntry = (await readNativeJobMap())[personalAction.id];
    const paused = await processTaskControlMarkers('[PAUSE_TASK: ' + personalAction.id + ']', context());
    assert.match(paused, /«Личная» на паузе/);
    assert.match(await processPauseMarkers('[STOP_ALL]', context(), {}), /снято с расписания задач: 1/);
    let jobs = await list(primary);
    assert.equal(jobs.find(row => row.id === entry.jobId)?.enabled, false);
    assert.equal(jobs.find(row => row.id === personalEntry.jobId)?.enabled, false);
    await delay(Math.max(0, Date.parse(at) - Date.now()) + 1000);
    assert.equal(modelCalls, 0);
    const resumed = await processPauseMarkers('[RESUME_ALL]', context(), {});
    assert.match(resumed, /задачи снова в работе \(1\)[\s\S]*Проверяемая/);
    assert.doesNotMatch(resumed, /Личная/);
    jobs = await list(primary);
    assert.equal(jobs.find(row => row.id === personalEntry.jobId)?.enabled, false);
  }

  const telegram = [];
  const start = () => startScheduler({ adminId: 42, timezone: 'Europe/Moscow', log() {},
    api: { sendMessage: async (...args) => { telegram.push(args.slice(0, 3)); } },
    runTurn: () => assert.fail('A native reminder must not use the bot foreground turn') });
  scheduler = start();
  const deadline = Date.now() + 65_000;
  do {
    await scheduler.tickNow();
    if (telegram.length) break;
    await delay(500);
  } while (Date.now() < deadline);
  const sent = [origin, '⏰ ' + reminder, { message_thread_id: 17,
    reply_parameters: { message_id: 43, allow_sending_without_reply: true } }];
  assert.deepEqual(telegram, [sent]);
  await scheduler.stop();
  scheduler = start();
  await scheduler.tickNow();
  assert.deepEqual(telegram, [sent]);

  const { entries } = await primary.run('cron', 'runs', '--id', entry.jobId, '--limit', '5', '--json');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].jobId, entry.jobId);
  assert.equal(entries[0].summary, modelSummary);
  assert.equal(entries[0].status, 'ok');
  assert.equal(entries[0].delivered, false);
  assert.equal(modelCalls, 1);
  if (personalEntry) {
    assert.equal((await list(primary)).find(row => row.id === personalEntry.jobId)?.enabled, false);
    await primary.run('cron', 'rm', personalEntry.jobId, '--json');
  }
  assert.deepEqual(await list(primary), before[0]);
  assert.deepEqual(await list(other), before[1]);
  assert.deepEqual(await protectedBytes(), snapshot);
  const [run] = await readSavedActionRunTail(5);
  assert.equal(run.nativeJobId, entry.jobId);
  assert.equal(run.status, 'ok');
  assert.equal((await readSavedActionRecords()).records[0].disabledReason, 'spent_once');
  console.log(JSON.stringify({ nativeModelCalls: modelCalls, nativeTerminalRun: true, exactOriginTopicAndReply: true,
    literalTelegramDeliveries: telegram.length, repeatedAfterRestart: false, noNativeDelivery: true,
    autoDeletedNativeJob: true, bothGatewaysPreexistingJobsUnchanged: true, protectedProfileBytesMatch: true,
    ...(mode === 'pause' ? { pausedThroughOwnerMarkers: true, resumedAfterDeadline: true,
      personalJobStillPaused: true, noModelCallUnderStop: true } : {}),
    network: 'loopback-only' }));
} finally {
  await scheduler?.stop();
  model.closeAllConnections();
  model.close();
  for (const { child } of processes) child.kill('SIGTERM');
  await Promise.race([Promise.all(processes.map(({ exit }) => exit)), delay(3_000)]);
  for (const { child } of processes) if (child.exitCode === null) child.kill('SIGKILL');
  await fs.rm(root, { recursive: true, force: true });
}
