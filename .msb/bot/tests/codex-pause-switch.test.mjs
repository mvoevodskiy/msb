/** Explicit Claude selection while a Codex pause is present.
 * Real Telegram/overlay routing with synthetic state, marker, CLI and credentials.
 * Old reference blob 73aa9e7e:3785–3803, 3848–3856, 109826–109879.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers/menu-fixture.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { createBot } from '../src/telegram/bot.mjs';
import { setActive, loadStore } from '../../../overlay/bot/ext/store.mjs';
import { syncExtAuthGate } from '../../../overlay/bot/ext/setup-bypass.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await wait(5); }
  throw Error(`Timed out: ${label}`);
}
async function sleepMarker() {
  const dir = path.join(process.env.MSB_RUNTIME_ROOT, 'engine');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const marker = path.join(dir, 'sleep.default');
  await fs.writeFile(marker, 'synthetic');
  return marker;
}

for (const selection of ['settings:engine:set:cc', 'ext:conn:set:claude']) {
test(`${selection} wakes the bot and preserves both CLI conversations`, async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const before = (await loadState()).state;
  await saveState({ ...before, parkedCcSessions: { claude: 'claude-session-fixture' } });
  const bin = path.join(f.home, '.local/bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\necho "Logged in using ChatGPT"\n', { mode: 0o700 });
  await fs.mkdir(path.join(f.home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(f.home, '.codex/auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  const marker = await sleepMarker();

  await f.callback(selection);
  let state = (await loadState()).state;
  assert.equal(state.extAuthBypass, undefined);
  assert.equal(state.ccSessionId, 'claude-session-fixture');
  assert.equal(state.parkedCcSessions.codex, before.ccSessionId);
  assert.equal(state.codexPauseSwitch, undefined);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'Selecting Claude must wake this bot.');

  await f.callback('ext:conn:set:codex');
  state = (await loadState()).state;
  assert.equal(state.extAuthBypass, 'codex');
  assert.equal(state.ccSessionId, before.ccSessionId);
  assert.equal(state.parkedCcSessions.claude, 'claude-session-fixture');
  await f.message('synthetic request after provider round trip');
  await until(() => f.messages.some(text => text.includes('fixture')), 'Codex answer after provider round trip');
});
}

test('an unconfigured Claude selection leaves Codex and its sleep marker intact', async t => {
  const f = await fixture(t);
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MSB_ANTHROPIC_API_KEY']) delete process.env[key];
  const before = (await loadState()).state;
  const marker = await sleepMarker();
  await f.callback('settings:engine:set:cc');
  const after = (await loadState()).state;
  assert.equal(after.extAuthBypass, 'codex');
  assert.equal(after.ccSessionId, before.ccSessionId);
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
});

test('a newer pause written during Claude selection is preserved', async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const marker = await sleepMarker();
  const next = marker + '.new';
  await fs.writeFile(next, 'newer');
  const rename = fs.rename;
  let replaced = false;
  fs.rename = async (source, target) => {
    const value = await rename(source, target);
    if (!replaced && String(target) === f.storeFile) {
      replaced = true;
      await rename(next, marker);
    }
    return value;
  };
  try { await f.callback('settings:engine:set:cc'); }
  finally { fs.rename = rename; }
  assert.equal(replaced, true);
  assert.equal((await loadState()).state.extAuthBypass, undefined);
  assert.equal(await fs.readFile(marker, 'utf8'), 'newer');
  assert.ok(f.edits.some(text => text.includes('Пауза изменилась')));
});

test('a pause changed during Telegram acknowledgement is newer than the selected pause', async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const marker = await sleepMarker();
  const next = marker + '.new';
  await fs.writeFile(next, 'newer');
  let replaced = false;
  f.bot.api.answerCallbackQuery = async () => {
    if (!replaced) { replaced = true; await fs.rename(next, marker); }
  };
  await f.callback('settings:engine:set:cc');
  assert.equal(replaced, true);
  assert.equal((await loadState()).state.extAuthBypass, undefined);
  assert.equal(await fs.readFile(marker, 'utf8'), 'newer');
});

test('a provider change during initial pause capture cannot be reported as the same switch', async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const before = (await loadState()).state;
  const marker = await sleepMarker();
  const stateFile = path.join(f.home, '.msb/bots/default/state.json');
  const read = fs.readFile;
  let switched = false;
  fs.readFile = async (file, ...options) => {
    const result = await read(file, ...options);
    if (!switched && String(file) === stateFile) {
      switched = true;
      const { extAuthBypass, ...other } = before;
      await saveState({ ...other, ccSessionId: 'newer-claude-session', sessionEpoch: 1 });
    }
    return result;
  };
  try { await f.callback('settings:engine:set:cc'); }
  finally { fs.readFile = read; }
  assert.equal(switched, true);
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
  assert.equal((await loadState()).state.ccSessionId, 'newer-claude-session');
  assert.ok(f.edits.some(text => text.includes('Пауза или движок изменились')));
});

test('a transient state read failure cannot bypass paused Codex selection', async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const marker = await sleepMarker();
  const stateFile = path.join(f.home, '.msb/bots/default/state.json');
  const read = fs.readFile;
  let failed = false;
  fs.readFile = async (file, ...options) => {
    if (!failed && String(file) === stateFile) {
      failed = true;
      throw Object.assign(Error('fixture transient state read error'), { code: 'EIO' });
    }
    return read(file, ...options);
  };
  try { await f.callback('settings:engine:set:cc'); }
  finally { fs.readFile = read; }
  assert.equal(failed, true);
  assert.equal((await loadState()).state.extAuthBypass, 'codex');
  assert.equal((await loadStore()).active, 'codex');
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
  assert.ok(f.edits.some(text => text.includes('Не удалось проверить паузу')));
});

for (const retrySelection of ['settings:engine:set:cc', 'ext:conn:set:claude']) {
test(`a failed wake can be retried through ${retrySelection} after process restart`, async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const marker = await sleepMarker();
  const unlink = fs.unlink;
  fs.unlink = async file => {
    if (String(file) === marker) throw Object.assign(Error('fixture denied'), { code: 'EACCES' });
    return unlink(file);
  };
  try { await f.callback('settings:engine:set:cc'); }
  finally { fs.unlink = unlink; }
  assert.equal((await loadState()).state.extAuthBypass, undefined);
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
  assert.ok(f.edits.some(text => text.includes('Не удалось подтвердить снятие паузы')));
  const restarted = createBot({ botToken: 'fake', botId: 'default', adminId: 42,
    workspace: f.workspace, timezone: 'Europe/Moscow' }, { bot: new f.bot.constructor(),
    runTurn: async () => ({ ok: true, text: 'fixture' }) });
  t.after(() => restarted.stop());
  await restarted.handleUpdate({ callback_query: { id: 'q2', data: retrySelection,
    from: { id: 42 }, message: { message_id: 1, chat: { id: 42 } } } });
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'A retry must clear the same pause after the error is fixed.');
  assert.equal((await loadState()).state.codexPauseSwitch, undefined);
});
}

test('a failed provider-store publication keeps Codex paused and an explicit retry can finish', async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const before = (await loadState()).state;
  const marker = await sleepMarker();
  const rename = fs.rename;
  let failed = false;
  fs.rename = async (source, target) => {
    if (!failed && String(target) === f.storeFile) {
      failed = true;
      throw Object.assign(Error('fixture store failure'), { code: 'EIO' });
    }
    return rename(source, target);
  };
  try { await f.callback('settings:engine:set:cc'); }
  finally { fs.rename = rename; }
  assert.equal(failed, true);
  let state = (await loadState()).state;
  assert.equal(state.extAuthBypass, 'codex');
  assert.equal(state.ccSessionId, before.ccSessionId);
  assert.equal(state.codexPauseSwitch.phase, 'prepared');
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
  await f.callback('settings:engine:set:cc');
  state = (await loadState()).state;
  assert.equal(state.extAuthBypass, undefined);
  assert.equal(state.parkedCcSessions.codex, before.ccSessionId);
  assert.equal(state.codexPauseSwitch, undefined);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('startup after store-only publication preserves Codex until Claude credentials are usable', async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const before = (await loadState()).state;
  const marker = await sleepMarker();
  const stateFile = path.join(f.home, '.msb/bots/default/state.json');
  const rename = fs.rename;
  let failed = false;
  fs.rename = async (source, target) => {
    if (!failed && String(target) === stateFile) {
      const proposed = JSON.parse(await fs.readFile(source, 'utf8'));
      if (proposed.codexPauseSwitch?.phase === 'committed') {
        failed = true;
        throw Object.assign(Error('fixture state failure'), { code: 'EIO' });
      }
    }
    return rename(source, target);
  };
  try { await f.callback('settings:engine:set:cc'); }
  finally { fs.rename = rename; }
  assert.equal(failed, true);
  assert.equal((await loadStore()).active, 'claude');
  assert.equal((await loadState()).state.codexPauseSwitch.phase, 'prepared');
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const notReady = await syncExtAuthGate();
  assert.equal(notReady.reason, 'pause-switch-need-claude-setup');
  assert.equal((await loadState()).state.extAuthBypass, 'codex');
  assert.equal((await loadState()).state.ccSessionId, before.ccSessionId);
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  await syncExtAuthGate();
  assert.equal((await loadState()).state.codexPauseSwitch.phase, 'committed');
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
  await f.callback('settings:engine:set:cc');
  const after = (await loadState()).state;
  assert.equal(after.codexPauseSwitch, undefined);
  assert.equal(after.parkedCcSessions.codex, before.ccSessionId);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('a newer provider choice prevents a delayed Claude selection from clearing the marker', async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const marker = await sleepMarker();
  const stateFile = path.join(f.home, '.msb/bots/default/state.json');
  const rename = fs.rename;
  let superseded = false;
  fs.rename = async (source, target) => {
    const result = await rename(source, target);
    if (!superseded && String(target) === stateFile) {
      const published = JSON.parse(await fs.readFile(target, 'utf8'));
      if (published.codexPauseSwitch?.phase === 'committed') {
        superseded = true;
        await setActive('codex');
      }
    }
    return result;
  };
  try { await f.callback('settings:engine:set:cc'); }
  finally { fs.rename = rename; }
  assert.equal(superseded, true);
  assert.equal((await loadStore()).active, 'codex');
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
});

test('a replaced marker after a failed wake stays intact on retry', async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const marker = await sleepMarker();
  const unlink = fs.unlink;
  fs.unlink = async file => {
    if (String(file) === marker) throw Object.assign(Error('fixture denied'), { code: 'EACCES' });
    return unlink(file);
  };
  try { await f.callback('settings:engine:set:cc'); }
  finally { fs.unlink = unlink; }
  assert.equal((await loadState()).state.codexPauseSwitch.phase, 'committed');
  await fs.writeFile(marker + '.new', 'newer');
  await fs.rename(marker + '.new', marker);
  await f.callback('settings:engine:set:cc');
  assert.equal(await fs.readFile(marker, 'utf8'), 'newer');
  assert.equal((await loadState()).state.codexPauseSwitch, undefined);
  assert.ok(f.edits.some(text => text.includes('Пауза изменилась')));
});

test('a retry can finish after wake succeeded but intent cleanup failed', async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const marker = await sleepMarker();
  const stateFile = path.join(f.home, '.msb/bots/default/state.json');
  const rename = fs.rename;
  let failed = false;
  fs.rename = async (source, target) => {
    if (!failed && String(target) === stateFile) {
      const proposed = JSON.parse(await fs.readFile(source, 'utf8'));
      const markerExists = await fs.stat(marker).then(() => true, () => false);
      if (!proposed.codexPauseSwitch && !proposed.extAuthBypass && !markerExists) {
        failed = true;
        throw Object.assign(Error('fixture state cleanup failure'), { code: 'EIO' });
      }
    }
    return rename(source, target);
  };
  try { await f.callback('settings:engine:set:cc'); }
  finally { fs.rename = rename; }
  assert.equal(failed, true);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal((await loadState()).state.codexPauseSwitch.phase, 'committed');
  await f.callback('settings:engine:set:cc');
  assert.equal((await loadState()).state.codexPauseSwitch, undefined);
});

test('a confirmed re-selection of Codex cancels a stale pending Claude switch', async t => {
  const f = await fixture(t);
  const before = (await loadState()).state;
  const marker = await sleepMarker();
  const profile = path.join(f.home, '.codex');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  await saveState({ ...before, codexPauseSwitch: { id: randomUUID(), revision: '1:2:3',
    phase: 'prepared', sourceEpoch: 0 } });
  const result = await syncExtAuthGate(process.env, f.home, { verifiedCodexProfile: profile });
  assert.equal(result.selected, true);
  const after = (await loadState()).state;
  assert.equal(after.codexPauseSwitch, undefined);
  assert.equal(after.ccSessionId, before.ccSessionId);
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
});

test('a Claude credential not available to the running process cannot clear the Codex pause', async t => {
  const f = await fixture(t);
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MSB_ANTHROPIC_API_KEY']) delete process.env[key];
  const marker = await sleepMarker();
  await fs.writeFile(path.join(f.home, '.msb/bots/default/.env'), 'CLAUDE_CODE_OAUTH_TOKEN=fixture-only\n');
  await f.callback('settings:engine:set:cc');
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
  assert.ok(f.edits.some(text => text.includes('Пауза сохранена')));
  assert.equal((await loadState()).state.extAuthBypass, 'codex');
  await f.callback('settings:engine:set:cc');
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic');
  assert.equal((await loadState()).state.extAuthBypass, 'codex');
});

test('an unreadable marker cannot block ordinary Claude reselection', async t => {
  const f = await fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-only';
  const { state } = await loadState();
  const { extAuthBypass, ccSessionId, ...claude } = state;
  await saveState({ ...claude, ccSessionId: 'claude-session-fixture' });
  const marker = await sleepMarker();
  const lstat = fs.lstat;
  fs.lstat = async (file, ...options) => String(file) === marker
    ? Promise.reject(Object.assign(Error('fixture denied'), { code: 'EACCES' })) : lstat(file, ...options);
  try { await f.callback('settings:engine:set:cc'); }
  finally { fs.lstat = lstat; }
  assert.ok(f.edits.some(text => text.includes('Агент теперь на')));
  assert.equal((await loadState()).state.ccSessionId, 'claude-session-fixture');
});
