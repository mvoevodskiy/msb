/**
 * Old first introduction through the actual Telegram queue and Codex shim.
 * All files and simulated CLI events are local to a temporary owner workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers/menu-fixture.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { runAgentTurn } from '../src/agent/turn.mjs';

const ordinary = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const introduction = '0299a213-81c0-7800-8aa1-bbab2a035a53';
const greeting = 'Меня только что подключили к твоему серверу. Давай настроюсь — как тебя зовут и чем занимаешься?';
const hub = /^Готов\. Пиши задачу или выбери действие\./;
const scope = '42:42:0';

async function waitFor(check) {
  const until = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('No bootstrap fixture result');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('cold Codex /start greets only before the old workspace readiness signals', async t => {
  const f = await fixture(t);
  const before = (await loadState()).state;
  await f.message('/start');
  assert.equal(f.messages.at(-1), greeting);
  assert.equal(f.messageOptions.at(-1)?.reply_markup, undefined);

  for (const relative of ['.iia-bootstrapped', 'SOUL.md', 'memory/some-note.md', 'knowledge/summary.md']) {
    const file = path.join(f.workspace, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture already configured');
    await f.message('/start');
    assert.match(f.messages.at(-1), hub);
    await fs.unlink(file);
  }
  const after = (await loadState()).state;
  assert.equal(after.ccSessionId, before.ccSessionId);
  assert.equal(after.extAuthBypass, 'codex');
});

async function nativeFixture(t) {
  const f = await fixture(t, runAgentTurn);
  const { state } = await loadState();
  const project = path.join(f.home, 'projects', 'alpha');
  const profile = path.join(project, 'native-profile');
  const bin = path.join(f.home, 'bin');
  const trace = path.join(f.home, 'codex-bootstrap-trace.jsonl');
  const started = path.join(f.home, 'codex-bootstrap-started');
  const resume = 'ext:codex:' + ordinary;
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(profile, 'auth.json'), '{"tokens":{"access_token":"local-test-token"}}');
  const config = 'model = "gpt-5.4-mini"\nmodel_provider = "fixture"\n';
  await fs.writeFile(path.join(profile, 'config.toml'), config);
  await saveState({ ...state, ccSessionId: resume, activeProject: 'alpha',
    lastCcUsage: { sessionId: resume, contextTokens: 4 } });
  const providers = JSON.parse(await fs.readFile(f.storeFile, 'utf8'));
  await fs.writeFile(f.storeFile, JSON.stringify({ ...providers, sessions: { codex: ordinary } }));
  process.env.CODEX_HOME = 'native-profile';
  const shim = fileURLToPath(new URL('../../../overlay/bot/ext/shim/bin/', import.meta.url));
  process.env.PATH = [shim, bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  const fake = '#!' + process.execPath + '\n' + [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const chunks = [];',
    '(async () => {',
    '  for await (const data of process.stdin) chunks.push(data);',
    '  const prompt = Buffer.concat(chunks).toString("utf8");',
    '  const argv = process.argv.slice(2);',
    '  const resumed = argv.includes("resume") ? argv[argv.indexOf("resume") + 1] : null;',
    '  fs.appendFileSync(' + JSON.stringify(trace) + ', JSON.stringify({ cwd: process.cwd(),',
    '    profile: path.resolve(process.env.CODEX_HOME), prompt, resumed }) + "\\n");',
    '  const id = resumed || ' + JSON.stringify(introduction) + ';',
    '  console.log(JSON.stringify({type:"thread.started",thread_id:id}));',
    '  if (prompt.includes("fixture wait for stop")) {',
    '    fs.writeFileSync(' + JSON.stringify(started) + ', "started");',
    '    setInterval(() => {}, 1000); return;',
    '  }',
    '  const finished = prompt.includes("fixture finish the introduction");',
    '  if (finished) {',
    '    fs.writeFileSync("SOUL.md", "# Fixture identity\\n");',
    '    fs.writeFileSync("USER.md", "# Fixture owner\\n");',
    '  }',
    '  const text = finished ? "fixture finished" : "fixture native reply";',
    '  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));',
    '  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:8,output_tokens:2}}));',
    '})();',
  ].join('\n');
  await fs.writeFile(path.join(bin, 'codex'), fake, { mode: 0o700 });
  const calls = async () => (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  return { ...f, profile, project, resume, started, calls, config };
}

test('Codex uses a separate introduction session in the base directory and resumes normal work afterward', async t => {
  const f = await nativeFixture(t);
  const store = await fs.readFile(f.storeFile, 'utf8');
  const firstScope = (await loadState()).state;
  const first = await runAgentTurn({ prompt: 'fixture introduction first answer', bootstrapScope: scope });
  assert.equal(first.ok, true);
  assert.equal(first.bootstrap, true);
  const afterFirst = (await loadState()).state;
  assert.equal(afterFirst.ccSessionId, f.resume);
  assert.deepEqual(afterFirst.lastCcUsage, firstScope.lastCcUsage);
  assert.deepEqual(afterFirst.sessionHistory, firstScope.sessionHistory);

  const finish = await runAgentTurn({ prompt: 'fixture finish the introduction', bootstrapScope: scope });
  assert.equal(finish.ok, true);
  assert.equal(finish.bootstrap, true);
  assert.equal(finish.bootstrapComplete, true);
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
  assert.equal(await fs.readFile(path.join(f.profile, 'config.toml'), 'utf8'), f.config);
  assert.match(await fs.readFile(path.join(f.workspace, 'SOUL.md'), 'utf8'), /Fixture identity/);
  await fs.stat(path.join(f.workspace, '.iia-bootstrapped'));
  await fs.stat(path.join(f.workspace, 'MEMORY.md'));
  await fs.stat(path.join(f.workspace, 'knowledge'));

  const ordinaryTurn = await runAgentTurn({ prompt: 'fixture ordinary task', bootstrapScope: scope });
  assert.equal(ordinaryTurn.ok, true);
  assert.equal(ordinaryTurn.bootstrap, undefined);
  const [firstCall, finishCall, regular] = await f.calls();
  assert.deepEqual([firstCall.resumed, finishCall.resumed, regular.resumed], [null, introduction, ordinary]);
  assert.equal(firstCall.cwd, await fs.realpath(f.workspace));
  assert.equal(finishCall.cwd, firstCall.cwd);
  assert.equal(regular.cwd, await fs.realpath(f.project));
  assert.equal(await fs.realpath(firstCall.profile), await fs.realpath(f.profile));
  assert.match(firstCall.prompt, /первую настройку|знакомство/i);
  assert.doesNotMatch(regular.prompt, /первую настройку с новым/i);
});

test('Codex introduction goes through Telegram /stop without replacing its ordinary session', async t => {
  const f = await nativeFixture(t);
  const store = await fs.readFile(f.storeFile, 'utf8');
  await f.message('fixture wait for stop');
  await waitFor(() => fs.access(f.started).then(() => true, () => false));
  await f.message('/stop');
  await waitFor(() => f.edits.some(text => text.includes('Моя остановочка')));
  assert.equal((await loadState()).state.ccSessionId, f.resume);
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
  const [request] = await f.calls();
  assert.equal(request.resumed, null);
  assert.equal(request.cwd, await fs.realpath(f.workspace));
  assert.match(request.prompt, /первую настройку|знакомство/i);
});
