import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamLineForTest, buildArgsForTest } from '../src/agent/claude-testables.mjs';
import { runAgentTurn } from '../src/agent/turn.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { mcpFixture } from './helpers/mcp-fixture.mjs';
import { nativeFixtures } from './helpers/mcp-launch-fixture.mjs';

test('stream-json parse', () => {
  assert.equal(parseStreamLineForTest(''), null);
  assert.deepEqual(parseStreamLineForTest('{"type":"system","subtype":"init"}'), {
    type: 'system',
    subtype: 'init',
  });
  assert.equal(parseStreamLineForTest('{not json'), null);
});

test('argv shape', () => {
  const args = buildArgsForTest({
    model: 'claude-opus-4-6',
    sessionId: 'abc',
    permissionMode: 'bypassPermissions',
    effort: 'high',
    systemPrompt: 'hi',
  });
  assert.equal(args[0], '-p');
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('abc'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('--effort'));
  assert.ok(args.includes('--append-system-prompt'));
});

test('legacy automatic Claude turn uses the old Sonnet route without replacing the saved choice', async t => {
  const fixture = await mcpFixture(t, 'claude');
  const native = await nativeFixtures(fixture);
  delete process.env.CC_AUTO_TURN_SONNET;
  const scenarios = [
    { ccModel: 'claude-opus-4-8', isAutoTurn: true, model: 'claude-sonnet-4-6' },
    { ccModel: 'opus[1m]', isAutoTurn: true, model: 'sonnet[1m]' },
    { ccModel: 'claude-opus-4-8', isAutoTurn: false, model: 'claude-opus-4-8' },
    { ccModel: 'claude-opus-4-8', isAutoTurn: true, optOut: true, model: 'claude-opus-4-8' },
  ];
  for (const { ccModel, isAutoTurn, optOut, model } of scenarios) {
    if (optOut) process.env.CC_AUTO_TURN_SONNET = '0';
    await saveState({ ...(await loadState()).state, ccModel });
    const result = await runAgentTurn({ prompt: 'Owned model fixture', isAutoTurn });
    assert.equal(result.ok, true, result.text);
    const { argv } = (await native.trace()).at(-1);
    assert.equal(argv[argv.indexOf('--model') + 1], model);
    assert.equal((await loadState()).state.ccModel, ccModel);
  }
});

test('legacy automatic turn keeps the selected native Codex model', async t => {
  const fixture = await mcpFixture(t, 'codex');
  const native = await nativeFixtures(fixture);
  await saveState({ ...(await loadState()).state, ccModel: 'claude-opus-4-8' });
  const result = await runAgentTurn({ prompt: 'Owned Codex fixture', isAutoTurn: true });
  assert.equal(result.ok, true, result.text);
  const { argv, kind } = (await native.trace()).at(-1);
  assert.equal(kind, 'codex-exec');
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-6.1-terra');
});
