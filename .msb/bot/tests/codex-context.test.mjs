import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSessionContext, formatContextUsage } from '../src/agent/context.mjs';
import { sessionsScreen, statusScreen, enginesScreen } from '../src/telegram/screens.mjs';

const id = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const sessionId = `ext:codex:${id}`;

test('native context uses latest request including cache, survives rate-only updates and resets on compaction', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-context-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home };
  const folder = path.join(home, '.codex/sessions/2026/11/05');
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, `rollout-2026-11-05T10-00-00-${id}.jsonl`);
  const count = (used, limit = 475000) => JSON.stringify({ type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { total_tokens: 1800000 },
      last_token_usage: { total_tokens: used, cached_input_tokens: used - 100 }, model_context_window: limit },
  } });
  await fs.writeFile(file, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-terra' } }) + '\n' +
    count(50000) + '\n' + count(71142) + '\n' +
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }) + '\n{partial');
  const value = await readSessionContext(sessionId, env);
  assert.equal(value.contextTokens, 71142);
  assert.equal(value.contextWindow, 475000);
  assert.equal(value.model, 'gpt-6.1-terra');
  assert.match(formatContextUsage(value), /Контекст: 15%/);
  assert.equal(await readSessionContext(undefined, env), null);
  assert.equal(await readSessionContext('ext:codex:../../auth', env), null);
  await fs.appendFile(file, '\n' + JSON.stringify({ type: 'compacted', payload: {} }) + '\n');
  assert.equal(await readSessionContext(sessionId, env), null);
  await fs.appendFile(file, count(12000, 258400) + '\n');
  assert.equal((await readSessionContext(sessionId, env)).contextTokens, 12000);
  await fs.appendFile(file, count(15000, null) + '\n');
  assert.equal(await readSessionContext(sessionId, env), null);
});

test('status, sessions and engines show active Codex, never stale Claude/model/context', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-status-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home };
  const folder = path.join(home, '.msb/bots/default');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'ext-providers.json'), JSON.stringify({ active: 'codex',
    models: { codex: 'gpt-6.1-terra' }, efforts: { codex: 'max' } }));
  const state = { engine: 'cc', extAuthBypass: 'codex', ccModel: 'opus', ccEffort: 'high',
    lastCcUsage: { sessionId, contextTokens: 71142, contextWindow: 475000 } };
  const cfg = { botId: 'default', workspace: '/tmp/test' };
  const status = await statusScreen(state, cfg, env);
  assert.match(status.text, /Codex/);
  assert.match(status.text, /gpt-6.1-terra/);
  assert.match(status.text, /max/);
  assert.doesNotMatch(status.text, /Claude|opus|15%/);
  assert.match(status.text, /нет данных текущей сессии/);
  assert.doesNotMatch((await sessionsScreen(state, env)).text, /Claude/);
  assert.doesNotMatch((await enginesScreen(state, env)).text, /Claude/);
});

test('status/engines honor native fallback; sessions show only the selected core provider ledger', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-native-display-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home };
  await fs.mkdir(path.join(home, '.msb/bots/default'), { recursive: true });
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(home, '.msb/bots/default/ext-providers.json'), JSON.stringify({ active: 'codex' }));
  await fs.writeFile(path.join(home, '.codex/config.toml'), 'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "max"\n[profiles.test]\nmodel = "other"\n');
  const state = { engine: 'cc' };
  const cfg = { botId: 'default', workspace: '/tmp/test' };
  const status = await statusScreen(state, cfg, env);
  assert.match(status.text, /gpt-6.1-terra/);
  assert.match(status.text, /max/);
  assert.equal((await sessionsScreen(state, env)).text,'Нет сохранённых сессий. Напиши что-нибудь, чтобы начать первую.');
  const withRows={...state,extAuthBypass:'codex',sessionHistory:[
    {id:sessionId,engine:'cc',firstPrompt:'Codex saved conversation',messageCount:1,lastActivity:'2099-01-01T00:00:00Z'},
    {id:'claude-other-fixture',engine:'cc',firstPrompt:'Claude foreign conversation',messageCount:1,lastActivity:'2099-01-01T00:00:00Z'}]};
  const sessions=await sessionsScreen(withRows,env);assert.match(sessions.text,/Codex saved conversation/);assert.doesNotMatch(sessions.text,/Claude foreign conversation/);
  assert.match((await enginesScreen(state, env)).text, /Codex/);
  for (const screen of [sessionsScreen, enginesScreen]) {
    assert.doesNotMatch((await screen({ extAuthBypass: 'codex' }, { ...env, JARVIS_CC_ONLY: '1' })).text, /Codex/);
  }
});

test('status reads the selected relative profile after compact and keeps the CLI sessions ledger layout', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-status-project-context-'));
  const previous = process.cwd();
  t.after(async () => { process.chdir(previous); await fs.rm(home, { recursive: true, force: true }); });
  const workspace = path.join(home, 'workspace');
  const project = path.join(home, 'projects', 'alpha');
  const env = { HOME: home, MSB_WORKSPACE_DIR: workspace, CODEX_HOME: 'native-profile' };
  const cfg = { botId: 'default', workspace };
  const state = { engine: 'cc', extAuthBypass: 'codex', ccSessionId: sessionId, activeProject: 'alpha',
    sessionHistory: [{ id: sessionId, engine: 'cc', firstPrompt: 'Saved project conversation', messageCount: 2 }] };
  const count = total_tokens => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: { total_tokens }, model_context_window: 100000 } } }) + '\n';
  const rollout = cwd => path.join(cwd, env.CODEX_HOME, 'sessions', 'rollout-fixture-' + id + '.jsonl');
  for (const [cwd, tokens] of [[workspace, 98000], [project, 18000]]) {
    await fs.mkdir(path.dirname(rollout(cwd)), { recursive: true });
    await fs.writeFile(rollout(cwd), count(tokens));
  }
  process.chdir(workspace);
  const statusText = () => statusScreen(state, cfg, env).then(view => view.text);
  assert.match(await statusText(), /Контекст: 18%/);
  assert.doesNotMatch(await statusText(), /98%/);
  await fs.appendFile(rollout(project), JSON.stringify({ type: 'compacted', payload: {} }) + '\n');
  assert.match(await statusText(), /Контекст: нет данных текущей сессии\./);
  await fs.appendFile(rollout(project), count(26000));
  assert.match(await statusText(), /Контекст: 26%/);
  const ledger = await sessionsScreen(state, env);
  assert.match(ledger.text, /Saved project conversation/);
  assert.doesNotMatch(ledger.text, /Контекст:/);
  await fs.rename(project, project + '-removed');
  assert.match(await statusText(), /Контекст: нет данных текущей сессии\./);
  process.chdir(home);
  assert.match((await statusScreen({ ...state, activeProject: undefined }, cfg, env)).text, /Контекст: 98%/);
});

test('status uses preferences from the selected project for relative CODEX_HOME', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-native-display-project-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const workspace = path.join(home, 'workspace');
  const env = { HOME: home, MSB_WORKSPACE_DIR: workspace, CODEX_HOME: 'native-profile' };
  const project = path.join(home, 'projects', 'alpha');
  for (const [cwd, model, effort] of [[workspace, 'gpt-5.4', 'low'], [project, 'gpt-5.4-mini', 'high']]) {
    const profile = path.join(cwd, env.CODEX_HOME);
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, 'config.toml'), 'model = "' + model + '" # root\n'
      + "model_reasoning_effort = '" + effort + "' # root\n[profiles.other]\nmodel = 'other'\n");
  }
  const state = { engine: 'cc', extAuthBypass: 'codex', ccModel: 'opus', activeProject: 'alpha' };
  const { text } = await statusScreen(state, { botId: 'default', workspace }, env);
  assert.match(text, /gpt-5\.4-mini/);
  assert.match(text, /high/);
  assert.doesNotMatch(text, /opus|low|other/);
});
