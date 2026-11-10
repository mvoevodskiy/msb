import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setActive, setSession, loadStore } from '../store.mjs';
import { syncExtAuthGate } from '../setup-bypass.mjs';
import { updateBotState } from '../state-update.mjs';
import { botStatePath } from '../paths.mjs';
import { runCodexTurn } from '../adapters/codex.mjs';

const claude = 'claude-session-fixture';
const codex = 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
const cursor = 'ext:cursor:0299a213-81c0-7800-8aa1-bbab2a035a54';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-provider-sessions-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home, MSB_BOT_ID: 'default', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only', CURSOR_API_KEY: 'fixture-cursor' };
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(home, '.codex/auth.json'), JSON.stringify({tokens:{access_token:'fixture-only'}}));
  await setActive('claude', env, home);
  // Historical metadata is not proof that this thread was not reset.
  await setSession('codex', '0199a213-81c0-7800-8aa1-bbab2a035a53', env, home);
  const file = botStatePath(env, home);
  await fs.writeFile(file, JSON.stringify({engine:'cc', authMode:'subscription', hasSubscriptionAuth:true,
    ccSessionId:claude, sessionEpoch:7, fixtureUnrelated:'preserve'}));
  const state = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  const select = async (id) => { await setActive(id, env, home); return syncExtAuthGate(env, home); };
  return { home, env, file, state, select };
}

test('provider switch parks each conversation and restores only the selected provider', async (t) => {
  const f = await fixture(t);
  await f.select('codex');
  let s = await f.state();
  assert.equal(s.ccSessionId, undefined, 'Do not revive unverified historical metadata');
  assert.equal(s.parkedCcSessions.claude, claude);
  assert.equal(s.sessionEpoch, 8);
  await updateBotState(x => { x.ccSessionId = codex; return x; }, f.env, f.home);
  await f.select('claude');
  s = await f.state();
  assert.equal(s.ccSessionId, claude);
  assert.equal(s.parkedCcSessions.codex, codex);
  assert.equal(s.parkedCcSessions.claude, undefined);
  assert.equal(s.sessionEpoch, 9);
  await f.select('codex');
  s = await f.state();
  assert.equal(s.ccSessionId, codex);
  assert.equal(s.parkedCcSessions.claude, claude);
  assert.equal(s.parkedCcSessions.codex, undefined);
  assert.equal(s.sessionEpoch, 10, 'A switch out and back invalidates late turn results');
  assert.equal(s.fixtureUnrelated, 'preserve');
});

test('reset current conversation does not revive it after switches; other provider is preserved', async (t) => {
  const f = await fixture(t);
  await f.select('codex');
  await updateBotState(x => { x.ccSessionId = codex; return x; }, f.env, f.home);
  await f.select('claude');
  await f.select('codex');
  await updateBotState(x => { delete x.ccSessionId; x.sessionEpoch = (x.sessionEpoch || 0) + 1; return x; }, f.env, f.home);
  await f.select('claude');
  assert.equal((await f.state()).ccSessionId, claude);
  await f.select('codex');
  const s = await f.state();
  assert.equal(s.ccSessionId, undefined, 'Explicit reset must win over old provider-store metadata');
  assert.equal(s.parkedCcSessions?.codex, undefined);
  assert.ok((await loadStore(f.env, f.home)).sessions.codex, 'Test the stale metadata case');
});

test('other CLI sessions stay provider-specific and reselecting the same provider is a no-op', async (t) => {
  const f = await fixture(t);
  await f.select('codex');
  await updateBotState(x => { x.ccSessionId = codex; return x; }, f.env, f.home);
  await f.select('cursor');
  assert.equal((await f.state()).ccSessionId, undefined);
  await updateBotState(x => { x.ccSessionId = cursor; return x; }, f.env, f.home);
  await f.select('codex');
  assert.equal((await f.state()).ccSessionId, codex);
  await f.select('cursor');
  const before = await fs.readFile(f.file, 'utf8');
  assert.equal((await f.state()).ccSessionId, cursor);
  await f.select('cursor');
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

test('temporary loss of active Codex authorization does not discard its current conversation', async (t) => {
  const f = await fixture(t);
  await f.select('codex');
  await updateBotState(x => { x.ccSessionId = codex; return x; }, f.env, f.home);
  const before = await fs.readFile(f.file, 'utf8');
  const auth = path.join(f.home, '.codex/auth.json');
  const bytes = await fs.readFile(auth);
  await fs.unlink(auth);
  const result = await syncExtAuthGate(f.env, f.home);
  assert.equal(result.changed, false);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  const bin = path.join(f.home, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const out = await runCodexTurn({ prompt:'fixture', parsed:{resume:codex}, cwd:f.home,
    env:{...f.env, PATH:bin}, home:f.home });
  assert.equal(out.ok, false);
  assert.match(out.text, /Нет нативной авторизации Codex/);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  await fs.writeFile(auth, bytes);
  await syncExtAuthGate(f.env, f.home);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

test('Claude selection restores parked Claude and preserves a foreign session after legacy OpenClaw state', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify({engine:'cc', ccSessionId:codex, ocSessionId:'openclaw-fixture',
    parkedCcSessions:{claude}, sessionEpoch:4, authMode:'subscription', hasSubscriptionAuth:true}));
  await setActive('claude', f.env, f.home);
  await syncExtAuthGate(f.env, f.home);
  const s = await f.state();
  assert.equal(s.ccSessionId, claude);
  assert.equal(s.parkedCcSessions.codex, codex);
  assert.equal(s.ocSessionId, 'openclaw-fixture');
  assert.equal(s.sessionEpoch, 5);
});

test('a stale Codex bypass marker does not delete an already active Claude session', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify({engine:'cc', extAuthBypass:'codex', ccSessionId:claude,
    sessionEpoch:4, authMode:'subscription', hasSubscriptionAuth:true}));
  await setActive('claude', f.env, f.home);
  await syncExtAuthGate(f.env, f.home);
  const s = await f.state();
  assert.equal(s.ccSessionId, claude);
  assert.equal(s.extAuthBypass, undefined);
  assert.equal(s.sessionEpoch, 5);
});

test('a stale Claude session is never passed to the selected Codex provider', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify({engine:'cc', extAuthBypass:'codex', ccSessionId:claude,
    parkedCcSessions:{codex}, sessionEpoch:4, authMode:'subscription', hasSubscriptionAuth:true}));
  await setActive('codex', f.env, f.home);
  await syncExtAuthGate(f.env, f.home);
  const s = await f.state();
  assert.equal(s.ccSessionId, codex);
  assert.equal(s.parkedCcSessions.claude, claude);
  assert.equal(s.sessionEpoch, 5);
});
