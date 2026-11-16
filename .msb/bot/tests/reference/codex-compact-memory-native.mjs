/**
 * Real native CLI -> production compact provider -> resumed native turn.
 * All data and model answers are synthetic. Run ONLY in a verified sandbox
 * that blocks external network and access to real user profiles; the fixture
 * itself does not enforce those OS boundaries. See
 * [evidence and reproduction](./parity-compact-memory-evidence.txt).
 * No JAR1 or live model involved.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [binary, source, fixtureParent] = process.argv.slice(2);
assert.ok([binary, source, fixtureParent].every(p => p && path.isAbsolute(p)),
  'provide absolute paths to Codex CLI, source root and disposable scratch parent');
const fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(fixtureParent, 'codex-compact-fixture-')));
const fixtureHome = path.join(fixtureRoot, 'user');
const fixtureCodex = path.join(fixtureRoot, 'codex');
const fixtureWorkspace = path.join(fixtureRoot, 'workspace');
const fixtureBin = path.join(fixtureRoot, 'bin');
const { runCodexTurn } = await import(pathToFileURL(path.join(source, 'overlay/bot/ext/adapters/codex.mjs')));
const { compactCodex, runCodexCompaction } = await import(pathToFileURL(path.join(source, 'overlay/bot/ext/compact-codex.mjs')));
const fixtureToken = 'loopback-fixture-access';
const jwt = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
})).toString('base64url') + '.fixture';
const facts = ['PROJECT=KITE-314', 'COLOUR=BRONZE-62', 'NEXT=RIVER-29'];
const summaryMarker = 'FIXTURE-COMPACTION-SUMMARY-7846';
let phase = 'seed', scenario = 'complete', expectedSeedFact, failure, lastCompactInput, resumeObservation;
const requests = [];
const server = http.createServer(async (req, res) => {
  requests.push({ phase, method: req.method, url: req.url });
  try {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) return res.writeHead(404).end();
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer ' + fixtureToken);
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (phase === 'compact') lastCompactInput = input;
    assert.equal(req.url, '/v1/responses');
    if (phase === 'seed') assert.ok(JSON.stringify(input.input).includes(expectedSeedFact), 'seed fact not sent');
    let answer = 'Fixture acknowledged.';
    if (phase === 'compact') {
      const serialized = JSON.stringify(input);
      const receivedFacts = facts.filter(fact => serialized.includes(fact));
      assert.deepEqual(receivedFacts, facts, 'compact input lacks fixture facts');
      if (scenario === 'omitted') receivedFacts.pop();
      answer = summaryMarker + ': ' + receivedFacts.join('; ');
    }
    if (phase === 'resume') {
      const summary = (input.input || []).find(item => JSON.stringify(item).includes(summaryMarker));
      const serialized = JSON.stringify(summary || {});
      resumeObservation = { summary: !!summary, facts: facts.map(fact => serialized.includes(fact)) };
      answer = 'Fixture summary: ' + resumeObservation.facts.filter(Boolean).length + '/' + facts.length;
    }
    const item = { id: 'msg_' + requests.length, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: answer, annotations: [] }] };
    const response = { id: 'resp_fixture_' + requests.length, created_at: 1,
      model: 'gpt-5.4', status: 'completed', output: [item] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [type, payload] of [
      ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
      ['response.output_item.done', { output_index: 0, item }],
      ['response.completed', { response }],
    ]) res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n');
    res.end();
  } catch (error) { failure = error; res.writeHead(500).end(); }
});
try {
  await Promise.all([fixtureHome, fixtureCodex, fixtureWorkspace, fixtureBin].map(p => fs.mkdir(p, { recursive: true, mode: 0o700 })));
  await fs.symlink(binary, path.join(fixtureBin, 'codex'));
  const authPath = path.join(fixtureCodex, 'auth.json');
  const configPath = path.join(fixtureCodex, 'config.toml');
  await fs.writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt',
    tokens: { id_token: jwt, access_token: fixtureToken, refresh_token: 'fixture', account_id: 'fixture-account' },
    last_refresh: new Date().toISOString() }), { mode: 0o600 });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  await fs.writeFile(configPath, 'model = "gpt-5.4"\nmodel_provider = "fixture"\n' +
    '[model_providers.fixture]\nname = "loopback fixture"\nbase_url = "http://127.0.0.1:' + server.address().port + '/v1"\n' +
    'wire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n');
  // These are synthetic home/profile paths for the child; the parent environment is not changed.
  const protectedFiles = await Promise.all([authPath, configPath].map(file => fs.readFile(file)));
  const fixtureEnv = { HOME: fixtureHome, CODEX_HOME: fixtureCodex,
    PATH: [fixtureBin, path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    TMPDIR: fixtureRoot, LANG: 'C.UTF-8', NO_PROXY: '127.0.0.1,localhost', MSB_BOT_ID: 'default' };
  const version = await new Promise((resolve, reject) => execFile(binary, ['--version'], { cwd: fixtureWorkspace, env: fixtureEnv, timeout: 10000 },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  const results = {}, threadIds = new Set();
  for (scenario of ['complete', 'omitted']) {
    phase = 'seed';
    let threadId;
    for (const fact of facts) {
      expectedSeedFact = fact;
      const initial = await runCodexTurn({ prompt: 'Fictional fact: ' + fact + '. ' + 'fixture detail '.repeat(120),
        parsed: threadId ? { resume: 'ext:codex:' + threadId } : {}, cwd: fixtureWorkspace,
        env: fixtureEnv, home: fixtureHome });
      if (failure) throw failure;
      assert.equal(initial.ok, true, JSON.stringify(initial));
      if (threadId) assert.equal(initial.nativeSessionId, threadId);
      else { threadId = initial.nativeSessionId; assert.equal(threadIds.has(threadId), false); threadIds.add(threadId); }
      assert.ok(threadId, 'native thread missing');
    }
    phase = 'compact'; lastCompactInput = undefined;
    const compacted = await compactCodex({ engine: 'cc', extAuthBypass: 'codex', ccSessionId: 'ext:codex:' + threadId },
      { env: fixtureEnv, cwd: fixtureWorkspace, run: args => runCodexCompaction({ ...args, timeoutMs: 25000 }) });
    if (failure) throw failure;
    assert.equal(compacted.ok, true, JSON.stringify(compacted));
    assert.ok(lastCompactInput, 'compact did not reach fixture');
    phase = 'resume'; resumeObservation = undefined;
    const resumed = await runCodexTurn({ prompt: 'Report the fictional facts.', parsed: { resume: 'ext:codex:' + threadId },
      cwd: fixtureWorkspace, env: fixtureEnv, home: fixtureHome });
    if (failure) throw failure;
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.nativeSessionId, threadId);
    assert.deepEqual(resumeObservation, { summary: true, facts: scenario === 'complete' ?
      [true, true, true] : [true, true, false] });
    assert.equal(resumed.text, scenario === 'complete' ? 'Fixture summary: 3/3' : 'Fixture summary: 2/3');
    results[scenario] = { same_thread: true, compact_confirmed: true, summary_facts: resumeObservation.facts };
  }
  assert.deepEqual(await Promise.all([authPath, configPath].map(file => fs.readFile(file))), protectedFiles);
  console.log(JSON.stringify({ version, scenarios: results, request_count: requests.length,
    fake_auth_and_config_unchanged: true, real_model: false, scope: 'synthetic transport only' }));
} catch (error) {
  console.error(JSON.stringify({ message: error.message, requests, model_failure: failure?.message }));
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
