import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const harness = fileURLToPath(new URL('./fixtures/provider-switch-harness.mjs', import.meta.url));
const networkGuard = new URL('./fixtures/network-deny.mjs', import.meta.url).href;
const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const session = `ext:codex:${thread}`;
const allUnchanged = { state: true, store: true, config: true, auth: true };

async function scenario(t, name) {
  // The native config lock uses physical paths, including macOS /var aliases.
  const fixtureHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'msb-engine-reference-')));
  t.after(() => fs.rm(fixtureHome, { recursive: true, force: true }));
  const { stdout } = await execute(process.execPath, [harness, name], {
    env: { HOME: fixtureHome, REFERENCE_HOME: fixtureHome, NODE_OPTIONS: `--import=${networkGuard}` },
    timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.forbiddenEffects, [], 'No system CLI or OS-helper request is allowed');
  assert.deepEqual(result.homeUnchanged, allUnchanged, 'Opening Engines must not rewrite the profile');
  assert.deepEqual(result.homeCli, [], 'Opening Engines must not probe login or install a CLI');
  assert.deepEqual(result.homeCoreCallbacks, ['eng:home'], 'Render through the real core router');
  assert.equal(result.menu.messageId, 1, 'Edit the menu message supplied by Telegram');
  assert.equal(result.menu.buttons.find((button) => button.text.includes('Codex'))?.callback_data,
    'ext:conn:set:codex', 'The displayed button must use the existing provider switch flow');
  assert.ok(result.menu.buttons.some((button) => button.callback_data === 'settings:engine:set:cc'));
  assert.ok(result.menu.buttons.some((button) => button.callback_data === 'eng:add'));
  assert.ok(result.menu.buttons.some((button) => button.callback_data === 'menu:settings'));
  return result;
}

function assertLoginChecks(result, count = 1) {
  assert.deepEqual(result.cli.map(({ name, argv, stdin }) => ({ name, argv, stdin })),
    Array.from({ length: count }, () => ({ name: 'codex', argv: ['login', 'status'], stdin: '' })),
    'Use native login status; do not start login, execute a model, or invoke OS helpers');
  assert.deepEqual(result.coreCallbacks, ['eng:home'], 'The overlay must consume its own Codex callback');
}

function assertSelectionsPreserved(result) {
  assert.deepEqual(result.store.sessions, { codex: thread });
  assert.deepEqual(result.store.models, { codex: 'gpt-6.1-sol' });
  assert.deepEqual(result.store.efforts, { codex: 'high' });
  assert.match(result.nativeConfig, /^model = "gpt-6\.1-sol"$/m);
  assert.match(result.nativeConfig, /^model_reasoning_effort = "high"$/m);
  assert.match(result.nativeConfig, /^approval_policy = "never"$/m);
  assert.equal(result.unchanged.auth, true, 'Selecting a provider must not replace native auth');
}

test('engines: real core renders canonical Codex selection without changing profile or probing login', async (t) => {
  const result = await scenario(t, 'engine-home');
  assert.match(result.menu.text, /Сейчас отвечает: <b>Codex<\/b>/);
  assert.equal(result.menu.buttons.find((button) => button.callback_data === 'ext:conn:set:codex').text,
    '🧠 Codex ✓');
  assert.deepEqual(result.unchanged, allUnchanged);
  assert.deepEqual(result.cli, []);
  assert.deepEqual(result.actionCalls, []);
  assert.equal(result.state.engine, 'cc', 'Codex is a provider, not a new core engine value');
  assert.equal(result.state.ccSessionId, session);
});

test('engines: the actual Codex button validates login and switches the existing provider flow', async (t) => {
  const result = await scenario(t, 'engine-valid-login');
  assertLoginChecks(result);
  assert.equal(result.store.active, 'codex');
  assert.equal(result.state.engine, 'cc');
  assert.equal(result.state.extAuthBypass, 'codex');
  assert.equal(result.state.ccSessionId, undefined, 'Do not resume a foreign Claude session in Codex');
  assertSelectionsPreserved(result);
  assert.ok(result.actionCalls.some((call) => String(call.payload.text || '').includes('Агент теперь на')));
});

test('engines: rejected Codex login preserves the current profile byte for byte', async (t) => {
  const result = await scenario(t, 'engine-invalid-login');
  assertLoginChecks(result);
  assert.deepEqual(result.unchanged, allUnchanged);
  assert.equal(result.store.active, 'claude');
  assert.equal(result.state.ccSessionId, 'reference-claude-session');
  assert.ok(result.actionCalls.some((call) => call.payload.reply_markup?.inline_keyboard?.flat()
    .some((button) => button.callback_data === 'ext:auth:codex')), 'Offer the existing native login action');
  assert.equal(result.actionCalls.some((call) => String(call.payload.text || '').includes('Агент теперь на')), false);
});

test('engines: a foreign owner cannot use the displayed Codex callback', async (t) => {
  const result = await scenario(t, 'engine-foreign-owner');
  assert.deepEqual(result.unchanged, allUnchanged);
  assert.deepEqual(result.cli, []);
  assert.deepEqual(result.actionCalls, [], 'Core adminGuard must silently reject the foreign update');
  assert.deepEqual(result.coreCallbacks, ['eng:home']);
  assert.equal(result.store.active, 'claude');
});

test('engines: reselecting Codex preserves its current session, model and effort', async (t) => {
  const result = await scenario(t, 'engine-reselect');
  assertLoginChecks(result, 2);
  assert.equal(result.store.active, 'codex');
  assert.equal(result.unchanged.state, true);
  assert.equal(result.state.ccSessionId, session);
  assert.equal(result.state.sessionEpoch, 7);
  assertSelectionsPreserved(result);
});

test('engines: successful Codex selection leaves legacy oc mode only after confirmed login', async (t) => {
  const result = await scenario(t, 'engine-oc-valid-login');
  assert.match(result.menu.text, /Сейчас отвечает: <b>OpenClaw<\/b>/);
  assert.equal(result.menu.buttons.find((button) => button.callback_data === 'ext:conn:set:codex').text,
    '🧠 Codex');
  assertLoginChecks(result);
  assert.equal(result.store.active, 'codex');
  assert.equal(result.state.engine, 'cc');
  assert.equal(result.state.extAuthBypass, 'codex');
  assert.equal(result.state.ccSessionId, undefined);
  assert.equal(result.state.sessionEpoch, 8);
  assert.equal(result.state.ocModel, 'openai/reference');
  assert.equal(result.state.ocSessionId, 'reference-oc-session');
  assertSelectionsPreserved(result);
});

test('engines: rejected Codex login leaves the legacy oc profile byte for byte', async (t) => {
  const result = await scenario(t, 'engine-oc-invalid-login');
  assertLoginChecks(result);
  assert.deepEqual(result.unchanged, allUnchanged);
  assert.equal(result.state.engine, 'oc');
  assert.equal(result.state.sessionEpoch, 7);
  assert.equal(result.store.active, 'claude');
  assert.equal(result.actionCalls.some((call) => String(call.payload.text || '').includes('Агент теперь на')), false);
});


for (const mode of ['absolute', 'relative', 'relative-login-button']) {
  test('engines: Codex validates and selects the ' + mode + ' native profile without rewriting either one', async (t) => {
    const r = await scenario(t, 'engine-profile-' + mode);
    assertLoginChecks(r);
    assert.equal(r.cli[0].profileDir, r.selectedProfile);
    assert.equal(r.store.active, 'codex');
    assert.equal(r.state.extAuthBypass, 'codex');
    assert.equal(r.state.ccSessionId, undefined);
    assert.equal(r.state.parkedCcSessions.claude, 'reference-claude-session');
    assert.equal(r.unchanged.config, true);
    assert.equal(r.unchanged.auth, true);
    assert.equal(r.selectedAuthUnchanged, true);
    assert.equal(r.selectedConfigUnchanged, true);
    assert.ok(r.actionCalls.some(call => String(call.payload.text).includes('Агент теперь на')));
  });
}

test('engines: missing selected project does not validate against the workspace or switch', async (t) => {
  const r = await scenario(t, 'engine-profile-relative-missing');
  assert.deepEqual(r.cli, []);
  assert.deepEqual(r.unchanged, allUnchanged);
  assert.equal(r.selectedAuthUnchanged, true);
  assert.equal(r.selectedConfigUnchanged, true);
  assert.equal(r.store.active, 'claude');
  assert.equal(r.state.ccSessionId, 'reference-claude-session');
});
