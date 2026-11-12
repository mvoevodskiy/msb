/** A selected Codex receives forwarded documents under the stock MSB bot profile. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsCodexAttachments, runAgentTurn } from '../src/agent/turn.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { fixture } from './helpers/menu-fixture.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';

async function until(check, label) {
  const deadline = Date.now() + 8_000;
  while (!await check()) {
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('the stock MSB flag does not block an explicitly selected Codex; the strict legacy flag still does', () => {
  const codex = { engine: 'cc', extAuthBypass: 'codex' };
  assert.equal(supportsCodexAttachments(codex, { MSB_CC_ONLY: '1' }), true);
  assert.equal(supportsCodexAttachments(codex, { MSB_CC_ONLY: '1', JARVIS_CC_ONLY: '1' }), false);
  assert.equal(supportsCodexAttachments(codex, { MSB_CC_ONLY: '0', JARVIS_CC_ONLY: '1' }), false);
  assert.equal(supportsCodexAttachments({ engine: 'oc', extAuthBypass: 'codex' }, { MSB_CC_ONLY: '1' }), false);
  assert.equal(supportsCodexAttachments({ engine: 'cc', extAuthBypass: 'claude' }, { MSB_CC_ONLY: '1' }), false);
  assert.equal(supportsCodexAttachments({ engine: 'cc' }, { MSB_CC_ONLY: '1' }), false);
});

test('a queued Codex attachment does not run after switching to Claude', async t => {
  await fixture(t, undefined, { overlay: false });
  process.env.MSB_CC_ONLY = '1';
  delete process.env.JARVIS_CC_ONLY;
  await saveState({ engine: 'cc', extAuthBypass: 'claude', ccSessionId: 'fixture-claude' });
  const before = (await loadState()).state;
  const result = await runAgentTurn({ prompt: 'fixture attachment', requireCodex: true });
  assert.equal(result.error, 'provider_changed');
  assert.deepEqual((await loadState()).state, before);
});

test('a forwarded document reaches the selected Codex through Telegram and its shim with stock MSB_CC_ONLY', async t => {
  const f = await mcpFixture(t, 'codex', { runTurn: runAgentTurn });
  for (const key of ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY', 'MSB_ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY']) delete process.env[key];
  const native = await nativeFixtures(f); // Installs only local fake binaries and fixture credentials.
  process.env.MSB_CC_ONLY = '1';
  delete process.env.JARVIS_CC_ONLY;
  const body = 'Контрольное содержимое документа 418';
  await native.respond('Документ получен.');
  t.mock.method(f.bot.api, 'getFile', async () => ({ file_path: 'fixture.txt' }));
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }));
  await f.bot.handleUpdate({ message: {
    message_id: 201, date: 1, chat: { id: 42 }, from: { id: 42 },
    forward_origin: { type: 'hidden_user', sender_user_name: 'Fixture' },
    document: { file_id: 'fixture', file_name: 'fixture.txt', mime_type: 'text/plain', file_size: Buffer.byteLength(body) },
  } });
  await until(() => f.edits.some(text => text.includes('Документ получен.')), 'Codex response');
  const calls = (await native.trace()).filter(row => row.kind === 'codex-exec');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes(body), 'the model receives the document contents');
  assert.ok(calls[0].prompt.includes('fixture.txt'), 'the model receives the document name');
});
