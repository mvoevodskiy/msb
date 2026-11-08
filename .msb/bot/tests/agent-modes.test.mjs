/** Old modes and actual production CLI options; no live authorization or tools. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers/menu-fixture.mjs';
import { saveState, loadState } from '../src/state.mjs';
const childFixture = fileURLToPath(new URL('./fixtures/agent-options.mjs', import.meta.url));
function options(provider, mode, model = 'opus', effort = 'high') {
  const child = spawnSync(process.execPath, [childFixture, provider, mode, model, effort], {
    env: { PATH: path.dirname(process.execPath), TMPDIR: os.tmpdir() }, encoding: 'utf8', timeout: 8000 });
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split('\n').find(s => s.startsWith('AGENT_OPTIONS='));
  assert.ok(line, child.stdout);
  const out = JSON.parse(line.slice('AGENT_OPTIONS='.length));
  assert.equal(out.ok, true); assert.equal(out.calls.length, 1);
  return out.calls[0];
}
const flag = (call, name) => call.args[call.args.indexOf(name) + 1];

test('Claude mode screen restores the three old visible choices and current selection', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  await saveState({ engine: 'cc', permissionMode: 'plan', ccSessionId: 'claude-fixture' });
  await f.callback('settings:permmode');
  assert.deepEqual(f.editOptions.at(-1).reply_markup.inline_keyboard.flat().map(b => [b.text, b.callback_data]), [
    ['Без спроса', 'settings:permmode:set:auto'], ['С подтверждением', 'settings:permmode:set:control'],
    ['Сначала план ✓', 'settings:permmode:set:plan'], ['« Назад', 'menu:agent'],
  ]);
  assert.match(f.edits.at(-1), /Смена режима начнёт новую беседу/);
});

test('unknown core mode normalizes to old auto fallback and keeps explicit reset semantics', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  const state = { engine: 'cc', permissionMode: 'control', ccSessionId: 'claude-fixture', fixture: true };
  await saveState(state);
  await f.callback('settings:permmode:set:unknown-fixture');
  assert.deepEqual((await loadState()).state, { engine: 'cc', permissionMode: 'auto', permMode: 'auto', fixture: true });
});

for (const mode of ['control', 'plan']) test(`Claude ${mode} uses old conversational prompt and acceptEdits, not a native planning restriction`, () => {
  const call = options('claude', mode);
  assert.equal(flag(call, '--permission-mode'), 'acceptEdits');
  assert.ok(flag(call, '--append-system-prompt').includes(`[КНОПКИ: ${mode}]`));
  assert.equal(call.prompt, 'synthetic options task');
});

test('auto/smart retain ordinary prompt; Codex saved mode never activates a Claude conversational gate', () => {
  for (const [provider, mode] of [['claude', 'auto'], ['claude', 'smart'], ['codex', 'control'], ['codex', 'plan']]) {
    const call = options(provider, mode);
    assert.doesNotMatch(flag(call, '--append-system-prompt'), /\[КНОПКИ: (control|plan)\]/);
    assert.equal(flag(call, '--permission-mode'), mode === 'smart' ? 'auto' : 'acceptEdits');
    assert.equal(call.provider, provider);
  }
});

test('overlay keeps unknown-mode auto fallback without resetting Codex native conversation or effort', async t => {
  const f = await fixture(t);
  const before = (await loadState()).state, store = await fs.readFile(f.storeFile, 'utf8');
  await f.callback('ext:permmode:set:unknown-fixture');
  assert.equal((await loadState()).state.permissionMode, 'auto');
  assert.equal((await loadState()).state.ccSessionId, before.ccSessionId);
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
});


test('persisted prototype-name modes cannot inject inherited object values into the system prompt', () => {
  const ordinary = flag(options('claude', 'auto'), '--append-system-prompt');
  for (const mode of ['constructor', 'toString', '__proto__']) {
    assert.equal(flag(options('claude', mode), '--append-system-prompt'), ordinary);
  }
});
