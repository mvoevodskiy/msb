/** Real core → shim → Codex CLI, but only a synthetic model on loopback.
 * Run in an isolated Linux container with MSB_TEST_CODEX_NATIVE pointing to the
 * pinned binary. No real credentials, provider, Telegram or owner sessions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaudeTurn } from '../src/agent/claude.mjs';

const binary = process.env.MSB_TEST_CODEX_NATIVE;
const waitFor = async (predicate, label) => {
  const limit = Date.now() + 20_000;
  while (!predicate()) { if (Date.now() > limit) throw Error(`timeout: ${label}`); await new Promise(r => setTimeout(r, 20)); }
};
const event = (response, type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);

test('native Codex preserves a session, steers its active turn, and aborts its process group',
  { skip: !binary && 'requires isolated pinned Codex binary', timeout: 70_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-native-steer-'));
    const home = path.join(root, 'home'), profile = path.join(root, 'profile'), workspace = path.join(root, 'workspace'), bin = path.join(root, 'bin');
    await Promise.all([home, profile, workspace, bin].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
    const shim = fileURLToPath(new URL('../../../overlay/bot/ext/shim/run-turn.mjs', import.meta.url));
    await fs.symlink(shim, path.join(bin, 'claude'));
    await fs.symlink(binary, path.join(bin, 'codex'));
    const requests = []; let held, stopHeld, serverError;
    const server = http.createServer(async (request, response) => {
      try {
        if (request.method === 'GET') return response.writeHead(404).end();
        assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
        let raw = ''; for await (const chunk of request) raw += chunk;
        const input = JSON.parse(raw), number = requests.length + 1;
        const row = { number, input: JSON.stringify(input.input), model: input.model, effort: input.reasoning?.effort };
        requests.push(row);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        event(response, 'response.created', { response: { id: `resp_${number}`, created_at: 1, model: 'gpt-5.4', status: 'in_progress', output: [] } });
        const finish = () => {
          const item = { id: `msg_${number}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `synthetic response ${number}`, annotations: [] }] };
          const result = { id: `resp_${number}`, created_at: 1, model: 'gpt-5.4', status: 'completed', output: [item],
            usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 10 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 120 } };
          event(response, 'response.output_item.done', { output_index: 0, item });
          event(response, 'response.completed', { response: result }); response.end();
        };
        if (row.input.includes('FIXTURE-STOP-47')) { stopHeld = response; return; }
        if (row.input.includes('FIXTURE-INITIAL-21') && !row.input.includes('FIXTURE-CORRECTION-32')) { held = finish; return; }
        finish();
      } catch (error) { serverError = error; if (!response.headersSent) response.writeHead(500); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const jwt = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url') + '.fixture';
    const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: jwt, access_token: 'fixture', refresh_token: 'fixture', account_id: 'fixture' }, last_refresh: new Date().toISOString() });
    const config = `model = "gpt-5.4"\nmodel_reasoning_effort = "high"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\napps = false\n`;
    await fs.writeFile(path.join(profile, 'auth.json'), auth, { mode: 0o600 });
    await fs.writeFile(path.join(profile, 'config.toml'), config, { mode: 0o600 });
    const before = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, { HOME: home, CODEX_HOME: profile, MSB_BOT_ID: 'default', MSB_WORKSPACE_DIR: workspace,
      PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8', NO_PROXY: '127.0.0.1,localhost', TMPDIR: root });
    let active, first, firstOutcome, resumed, stopped;
    const firstController = new AbortController(), resumeController = new AbortController(), stopController = new AbortController();
    try {
      const onSteerReady = handle => { if (handle) active = handle; };
      first = runClaudeTurn({ cwd: workspace, prompt: 'FIXTURE-INITIAL-21', providerId: 'codex', systemPrompt: 'FIXTURE-SYSTEM-88', signal: firstController.signal, onSteerReady });
      first.then(result => { firstOutcome = result; }, error => { firstOutcome = { error: error.message }; });
      try { await waitFor(() => (held && active) || firstOutcome || serverError, 'first request and control channel'); }
      catch (error) { throw Error(`${error.message}: requests=${requests.length} held=${Boolean(held)} ready=${Boolean(active)} server=${serverError?.message || 'ok'}`); }
      assert.ok(held && active, `first turn ended too early: ${JSON.stringify({ requests: requests.length, held: Boolean(held), ready: Boolean(active), firstOutcome, serverError: serverError?.message })}`);
      assert.deepEqual(await active.steer('FIXTURE-CORRECTION-32'), { status: 'accepted' });
      held();
      const firstResult = await first;
      assert.equal(firstResult.isError, false); assert.match(firstResult.sessionId, /^ext:codex:/);
      assert.ok(requests.some(row => row.input.includes('FIXTURE-SYSTEM-88')));
      assert.ok(requests.some(row => row.input.includes('FIXTURE-CORRECTION-32')));
      assert.equal(firstResult.providerId, 'codex'); assert.equal(active.active, false);
      const firstCount = requests.length;
      assert.ok(firstCount >= 2);
      // Native steer discards the in-flight first response and records only the
      // completed response which included the correction, not both HTTP starts.
      assert.deepEqual(firstResult.usage, { inputTokens: 90, outputTokens: 20, cacheReadTokens: 10, cacheCreationTokens: 0 });
      const session = firstResult.sessionId;
      resumed = runClaudeTurn({ cwd: workspace, prompt: 'FIXTURE-NEXT-59', sessionId: session, providerId: 'codex', signal: resumeController.signal, onSteerReady });
      const resumedResult = await resumed;
      assert.equal(resumedResult.isError, false); assert.equal(resumedResult.sessionId, session);
      assert.ok(requests.some(row => row.input.includes('FIXTURE-NEXT-59')));
      assert.deepEqual(resumedResult.usage, { inputTokens: 180, outputTokens: 40, cacheReadTokens: 20, cacheCreationTokens: 0 });
      assert.ok(requests.every(row => row.model === 'gpt-5.4' && row.effort === 'high'));
      active = null;
      stopped = runClaudeTurn({ cwd: workspace, prompt: 'FIXTURE-STOP-47', sessionId: session, providerId: 'codex', signal: stopController.signal, onSteerReady });
      await waitFor(() => stopHeld && active, 'stoppable request');
      stopController.abort(); const stoppedResult = await stopped;
      assert.equal(stoppedResult.aborted, true); assert.equal(active.active, false);
      assert.equal(await fs.readFile(path.join(profile, 'auth.json'), 'utf8'), auth);
      assert.equal(await fs.readFile(path.join(profile, 'config.toml'), 'utf8'), config);
      if (serverError) throw serverError;
    } finally {
      firstController.abort(); resumeController.abort(); stopController.abort();
      stopHeld?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      let timeout;
      const drained = await Promise.race([Promise.allSettled([first, resumed, stopped].filter(Boolean)).then(() => true),
        new Promise(resolve => { timeout = setTimeout(() => resolve(false), 12_000); })]);
      clearTimeout(timeout);
      for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, before);
      if (!drained) throw Error('fixture process groups did not close');
      await fs.rm(root, { recursive: true, force: true });
    }
  });
