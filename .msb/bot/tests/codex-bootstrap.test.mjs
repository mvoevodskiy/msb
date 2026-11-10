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
  const { state } = await loadState();
  const before = { ...state, ccSessionId: undefined };
  await saveState(before);
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

async function nativeFixture(t, { ordinarySession = false } = {}) {
  const f = await fixture(t, runAgentTurn);
  const { state } = await loadState();
  const project = path.join(f.home, 'projects', 'alpha');
  const profile = path.join(project, 'native-profile');
  const bin = path.join(f.home, 'bin');
  const trace = path.join(f.home, 'codex-bootstrap-trace.jsonl');
  const started = path.join(f.home, 'codex-bootstrap-started');
  const release = path.join(f.home, 'codex-bootstrap-release');
  const resume = 'ext:codex:' + ordinary;
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(profile, 'auth.json'), '{"tokens":{"access_token":"local-test-token"}}');
  const config = 'model = "gpt-5.4-mini"\nmodel_provider = "fixture"\n';
  await fs.writeFile(path.join(profile, 'config.toml'), config);
  await saveState({ ...state, ccSessionId: ordinarySession ? resume : undefined, activeProject: 'alpha',
    lastCcUsage: ordinarySession ? { sessionId: resume, contextTokens: 4 } : undefined });
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
    '  if (prompt.includes("fixture wait for clear")) {',
    '    fs.writeFileSync(' + JSON.stringify(started) + ', "started");',
    '    while (!fs.existsSync(' + JSON.stringify(release) + ')) await new Promise(r => setTimeout(r, 10));',
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
  return { ...f, profile, project, resume, started, release, calls, config };
}

test('Codex uses a separate introduction session in the base directory and resumes normal work afterward', async t => {
  const f = await nativeFixture(t);
  const store = await fs.readFile(f.storeFile, 'utf8');
  const firstScope = (await loadState()).state;
  const first = await runAgentTurn({ prompt: 'fixture introduction first answer', bootstrapScope: scope });
  assert.equal(first.ok, true);
  assert.equal(first.bootstrap, true);
  const afterFirst = (await loadState()).state;
  assert.equal(afterFirst.ccSessionId, firstScope.ccSessionId);
  assert.deepEqual(afterFirst.lastCcUsage, firstScope.lastCcUsage);
  assert.deepEqual(afterFirst.sessionHistory, firstScope.sessionHistory);
  const usage = { sessionId: f.resume, contextTokens: 4 };
  await saveState({ ...afterFirst, ccSessionId: f.resume, lastCcUsage: usage });

  const finish = await runAgentTurn({ prompt: 'fixture finish the introduction', bootstrapScope: scope });
  assert.equal(finish.ok, true);
  assert.equal(finish.bootstrap, true);
  assert.equal(finish.bootstrapComplete, true);
  const afterFinish = (await loadState()).state;
  assert.equal(afterFinish.ccSessionId, f.resume);
  assert.deepEqual(afterFinish.lastCcUsage, usage);
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
  await saveState({ ...(await loadState()).state, ccSessionId: f.resume });
  await f.message('/stop');
  await waitFor(() => f.edits.some(text => text.includes('Моя остановочка')));
  assert.equal((await loadState()).state.ccSessionId, f.resume);
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
  const [request] = await f.calls();
  assert.equal(request.resumed, null);
  assert.equal(request.cwd, await fs.realpath(f.workspace));
  assert.match(request.prompt, /первую настройку|знакомство/i);
});


test('the old attempt cap completes the workspace without a ninth native call or overwriting owner files', async t => {
  const f = await nativeFixture(t);
  const { state } = await loadState();
  await fs.writeFile(path.join(f.workspace, 'USER.md'), 'Owner file already present');
  await fs.writeFile(path.join(f.workspace, 'CLAUDE.md'), 'Rules already present');
  await saveState({ ...state, codexBootstrap: { [scope]: {
    workspace: f.workspace, profileDir: f.profile, turns: 8, sessionId: 'ext:codex:' + introduction,
  } } });
  const store = await fs.readFile(f.storeFile, 'utf8');
  const output = await runAgentTurn({ prompt: 'fixture ninth answer', bootstrapScope: scope });
  assert.equal(output.bootstrapComplete, true);
  assert.match(output.text, /^Знакомство завершено!/);
  await assert.rejects(f.calls, { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.workspace, 'USER.md'), 'utf8'), 'Owner file already present');
  assert.equal(await fs.readFile(path.join(f.workspace, 'CLAUDE.md'), 'utf8'), 'Rules already present');
  await fs.stat(path.join(f.workspace, 'SOUL.md'));
  await fs.stat(path.join(f.workspace, '.iia-bootstrapped'));
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
  assert.equal((await loadState()).state.ccSessionId, undefined);
});

test('a failed defaults write can be retried without another native introduction turn', async t => {
  const f = await nativeFixture(t);
  const store = await fs.readFile(f.storeFile, 'utf8');
  const link = fs.link;
  let injected = false;
  t.mock.method(fs, 'link', async (source, target) => {
    if (!injected && target === path.join(f.workspace, 'MEMORY.md')) {
      injected = true;
      throw Object.assign(new Error('fixture interrupted defaults publication'), { code: 'EACCES' });
    }
    return link(source, target);
  });
  await assert.rejects(runAgentTurn({ prompt: 'fixture finish the introduction', bootstrapScope: scope }),
    /fixture interrupted defaults publication/);
  assert.equal(injected, true);
  await assert.rejects(fs.stat(path.join(f.workspace, '.iia-bootstrapped')), { code: 'ENOENT' });
  assert.equal((await loadState()).state.codexBootstrap[scope].finish, 'profile');
  const output = await runAgentTurn({ prompt: 'fixture retry defaults', bootstrapScope: scope });
  assert.equal(output.bootstrapComplete, true);
  assert.equal((await f.calls()).length, 1);
  await fs.stat(path.join(f.workspace, 'MEMORY.md'));
  await fs.stat(path.join(f.workspace, '.iia-bootstrapped'));
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
});

test('newtask leaves the introduction resume available, and clear fences a late reply', async t => {
  const f = await nativeFixture(t);
  await runAgentTurn({ prompt: 'fixture first answer', bootstrapScope: scope });
  await f.message('/newtask');
  let state = (await loadState()).state;
  assert.equal(state.ccSessionId, undefined);
  assert.equal(state.codexBootstrap[scope].sessionId, 'ext:codex:' + introduction);

  await f.message('fixture wait for clear');
  await waitFor(() => fs.access(f.started).then(() => true, () => false));
  await f.message('/clear');
  await fs.writeFile(f.release, 'release');
  await waitFor(() => f.edits.some(text => text.includes('Контекст знакомства изменился.')));
  state = (await loadState()).state;
  assert.equal(state.codexBootstrap, undefined);
  assert.equal(state.ccSessionId, undefined);
  assert.equal((await f.calls())[1].resumed, introduction);
});

test('a scheduled Codex turn keeps its normal session and project even on a cold workspace', async t => {
  const f = await nativeFixture(t);
  const output = await runAgentTurn({ prompt: 'fixture scheduled task', isAutoTurn: true, bootstrapScope: scope });
  assert.equal(output.ok, true);
  assert.equal(output.bootstrap, undefined);
  const [request] = await f.calls();
  assert.equal(request.cwd, await fs.realpath(f.project));
  assert.equal(request.resumed, null);
  assert.equal((await loadState()).state.codexBootstrap, undefined);
});


test('existing open-core Codex conversations bypass introduction even after reset in an empty workspace', async t => {
  const f = await nativeFixture(t, { ordinarySession: true });
  await f.message('/start');
  assert.match(f.messages.at(-1), hub);
  const first = await runAgentTurn({ prompt: 'fixture previously configured', bootstrapScope: scope });
  assert.equal(first.bootstrap, undefined);
  await f.message('/newtask');
  const afterReset = await runAgentTurn({ prompt: 'fixture after ordinary reset', bootstrapScope: scope });
  assert.equal(afterReset.bootstrap, undefined);
  assert.deepEqual((await f.calls()).map(call => call.resumed), [ordinary, null]);
  assert.equal((await loadState()).state.codexBootstrap, undefined);
});

test('Telegram delivers a bootstrap reply without the ordinary footer and then opens the ready hub', async t => {
  const f = await nativeFixture(t);
  await f.message('fixture finish the introduction');
  await waitFor(() => f.edits.some(text => text === 'fixture finished'));
  assert.doesNotMatch(f.edits.find(text => text.includes('fixture finished')), /⏱|blockquote/);
  await f.message('/start');
  assert.match(f.messages.at(-1), hub);
});
