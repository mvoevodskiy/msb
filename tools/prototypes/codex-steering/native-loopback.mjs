/**
 * Actual Codex app-server + [prototype queue](./queue.mjs), synthetic model.
 * Run only inside a network-none Linux container with a disposable HOME and
 * profile. No personal credentials, existing sessions, Telegram or JAR1.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PrototypeQueue } from './queue.mjs';
import { NativeSession } from './session.mjs';
import { assertNoSavedSessions } from './ephemeral.mjs';

const binary = process.argv[2];
assert.ok(binary && path.isAbsolute(binary), 'pass absolute path to disposable CLI binary');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'msb-steer-loopback-')));
const fixtureHome = path.join(root, 'home'), fixtureProfile = path.join(root, 'codex');
const workspace = path.join(root, 'workspace');
const access = 'synthetic-loopback-only';
const jwt = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
})).toString('base64url') + '.fixture';
const requests = [], events = [];
let firstResponse, stopResponse, fixtureError, firstReleased = false;

const waitFor = async (predicate, label, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (fixtureError) throw fixtureError;
    if (Date.now() >= end) throw Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

function event(response, type, payload) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function finish(response, number, text) {
  const item = { id: `msg_fixture_${number}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const result = { id: `resp_fixture_${number}`, created_at: 1, model: 'gpt-5.4',
    status: 'completed', output: [item] };
  event(response, 'response.output_item.done', { output_index: 0, item });
  event(response, 'response.completed', { response: result });
  response.end();
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url.startsWith('/v1/models')) return response.writeHead(404).end();
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.headers.authorization, `Bearer ${access}`);
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const serialized = JSON.stringify(input.input);
    const row = { number: requests.length + 1,
      initial: serialized.includes('FIXTURE-INITIAL-91'),
      correction: serialized.includes('FIXTURE-CORRECTION-42'),
      queued: serialized.includes('FIXTURE-QUEUED-73'),
      stop: serialized.includes('FIXTURE-STOP-15'),
      never: serialized.includes('FIXTURE-NEVER-28') };
    requests.push(row);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    event(response, 'response.created', { response: { id: `resp_fixture_${row.number}`, created_at: 1,
      model: 'gpt-5.4', status: 'in_progress', output: [] } });
    if (row.stop && !stopResponse) { stopResponse = response; return; }
    if (!firstReleased && row.initial && !row.correction && !row.queued) { firstResponse = response; return; }
    finish(response, row.number, 'Synthetic model response.');
  } catch (error) {
    fixtureError = error;
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

let session, queue, outcome;
try {
  await Promise.all([fixtureHome, fixtureProfile, workspace].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const config = 'model = "gpt-5.4"\nmodel_provider = "fixture"\n' +
    '[model_providers.fixture]\nname = "Loopback fixture"\nbase_url = "http://127.0.0.1:' + server.address().port + '/v1"\n' +
    'wire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n';
  await fs.writeFile(path.join(fixtureProfile, 'config.toml'), config, { mode: 0o600 });
  await fs.writeFile(path.join(fixtureProfile, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt',
    tokens: { id_token: jwt, access_token: access, refresh_token: 'fixture', account_id: 'fixture-account' },
    last_refresh: new Date().toISOString() }), { mode: 0o600 });
  const env = { HOME: fixtureHome, CODEX_HOME: fixtureProfile, TMPDIR: root,
    PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', NO_PROXY: '127.0.0.1,localhost' };
  const version = execFileSync(binary, ['--version'], { cwd: workspace, env, encoding: 'utf8', timeout: 10_000 }).trim();
  assert.equal(version, 'codex-cli 0.166.0', 'the probe targets the pinned JAR1 CLI version');
  session = await NativeSession.open({ command: binary, cwd: workspace, env, timeoutMs: 30_000 });
  queue = new PrototypeQueue({ driver: session, notify: row => events.push(row) });

  queue.submit({ id: 'initial', text: 'FIXTURE-INITIAL-91' });
  await waitFor(() => firstResponse && queue.active?.id, 'first active turn and model request');
  const firstTurn = queue.active.id;
  queue.submit({ id: 'correction', text: 'FIXTURE-CORRECTION-42' });
  queue.submit({ id: 'queued', text: 'FIXTURE-QUEUED-73' });
  assert.deepEqual(await queue.steer('correction'), { status: 'accepted' });
  assert.equal(queue.active.id, firstTurn);
  assert.deepEqual(queue.pending.map(row => row.id), ['queued']);
  firstReleased = true;
  finish(firstResponse, 1, 'Synthetic first response.');
  await waitFor(() => events.some(row => row.type === 'finished' && row.id === 'queued'), 'queued follow-up');
  assert.ok(requests.some(row => row.correction && !row.queued), 'model did not receive steering in the original turn');
  assert.ok(requests.some(row => row.queued), 'model did not receive the queued next turn');
  const started = events.filter(row => row.type === 'started');
  assert.equal(started.length, 2);
  assert.notEqual(started[0].turnId, started[1].turnId);
  assert.ok(events.some(row => row.type === 'steered' && row.turnId === started[0].turnId));

  queue.submit({ id: 'stop-current', text: 'FIXTURE-STOP-15' });
  await waitFor(() => stopResponse && queue.active?.id, 'active turn to stop');
  queue.submit({ id: 'stop-queued', text: 'FIXTURE-NEVER-28' });
  const stopped = await queue.stop();
  assert.deepEqual(stopped, { cleared: ['stop-queued'], active: true });
  await waitFor(() => events.some(row => row.type === 'finished' && row.id === 'stop-current'), 'native interruption');
  assert.equal(events.find(row => row.type === 'finished' && row.id === 'stop-current').status, 'interrupted');
  assert.equal(requests.some(row => row.never), false);
  assert.equal(queue.pending.length, 0);
  if (fixtureError) throw fixtureError;
  outcome = { version, ephemeral_thread: true, same_turn_steered: true,
    correction_seen_by_model_fixture: true, queued_next_turn: true, stop_interrupted: true,
    stop_cleared_queue: true, requests: requests.length, real_model: false, personal_auth: false };
} catch (error) {
  console.error(JSON.stringify({ error: error.message, requests, events: events.map(({ type, id, status }) => ({ type, id, status })) }));
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  if (queue) try { await queue.close(); } catch (error) { cleanupErrors.push(error.message); }
  if (session) try { await session.close(); } catch (error) { cleanupErrors.push(error.message); }
  if (outcome) try { await assertNoSavedSessions(fixtureProfile); } catch (error) { cleanupErrors.push(error.message); }
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
  if (cleanupErrors.length) {
    console.error(JSON.stringify({ cleanup_not_confirmed: cleanupErrors }));
    process.exitCode = 1;
  }
  if (outcome && !cleanupErrors.length && !process.exitCode) console.log(JSON.stringify({ ...outcome, cleanup: 'leader-and-group-checked' }));
}
