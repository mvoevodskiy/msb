import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  hasNativeCodexAuth,
  parseCodexTomlScalars,
  readCodexNativeConfig,
  resolveCodexModel,
  resolveCodexEffort,
  isClaudeModelAlias,
  isValidCodexThreadId,
  isCodexSessionSentinel,
  CODEX_NPM_SPEC,
  CODEX_CLI_VERSION,
} from '../codex-native.mjs';
import { parseCodexStdout, buildCodexExecArgs } from '../adapters/codex.mjs';
import { decodeExtSession } from '../store.mjs';
import { providerConfigured } from '../env.mjs';
import { getProvider } from '../providers.mjs';

test('CODEX version pinned to 0.166.0', () => {
  assert.equal(CODEX_CLI_VERSION, '0.166.0');
  assert.equal(CODEX_NPM_SPEC, '@openai/codex@0.166.0');
});

test('hasNativeCodexAuth detects tokens without exposing secrets', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-codex-'));
  assert.equal(await hasNativeCodexAuth(home), false);
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.codex', 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'secret-should-not-leak', refresh_token: 'r' },
    }),
    { mode: 0o600 },
  );
  assert.equal(await hasNativeCodexAuth(home), true);
  assert.equal(await providerConfigured(getProvider('codex'), { MSB_BOT_ID: 'default' }, home), true);
});

test('parseCodexTomlScalars reads model and effort', () => {
  const s = parseCodexTomlScalars(`
# comment
model = "gpt-6.1-sol"
model_reasoning_effort = "high"
approval_policy = "never"
`);
  assert.equal(s.model, 'gpt-6.1-sol');
  assert.equal(s.model_reasoning_effort, 'high');
  assert.equal(s.approval_policy, 'never');
});

test('resolveCodexModel drops Claude aliases, prefers native config', async () => {
  assert.equal(isClaudeModelAlias('claude-opus-4-7'), true);
  assert.equal(isClaudeModelAlias('gpt-6.1-sol'), false);
  assert.equal(resolveCodexModel('claude-opus-4-7', { model: 'gpt-6.1-sol' }), 'gpt-6.1-sol');
  assert.equal(resolveCodexModel('gpt-5-codex', { model: 'gpt-6.1-sol' }), 'gpt-5-codex');
  assert.equal(
    resolveCodexModel('claude-opus-4-7', { model: 'gpt-6.1-sol' }, 'gpt-6.1-sol'),
    'gpt-6.1-sol',
  );
  assert.equal(resolveCodexEffort({ modelReasoningEffort: 'high' }), 'high');

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-codex-cfg-'));
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.codex', 'config.toml'),
    'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n',
  );
  const cfg = await readCodexNativeConfig(home);
  assert.equal(cfg.model, 'gpt-6.1-sol');
  assert.equal(cfg.modelReasoningEffort, 'high');
});

test('isValidCodexThreadId rejects fake timestamp ids', () => {
  assert.equal(isValidCodexThreadId('0199a213-81c0-7800-8aa1-bbab2a035a53'), true);
  assert.equal(isValidCodexThreadId(`x${Date.now()}`), false);
  assert.equal(isValidCodexThreadId(Date.now().toString(36)), false);
  assert.equal(isValidCodexThreadId('ab'), false);
});

test('sentinel norestart after websocket error is not a valid resume id', () => {
  assert.equal(isCodexSessionSentinel('norestart'), true);
  assert.equal(isCodexSessionSentinel('norestart-m1x2y3'), true);
  assert.equal(isValidCodexThreadId('norestart'), false);
  const decoded = decodeExtSession('ext:codex:norestart');
  assert.deepEqual(decoded, { providerId: 'codex', nativeId: 'norestart' });
  // Как в адаптере: битый resume → null → новый тред, не «Повреждённый ID»
  const resumeRequested =
    decoded?.providerId === 'codex' && isValidCodexThreadId(decoded.nativeId)
      ? decoded.nativeId
      : null;
  assert.equal(resumeRequested, null);
});

test('parseCodexStdout marks websocket reconnect exhaustion as turnFailed', () => {
  const msg =
    'Reconnecting... 5/5 (stream disconnected before completion: websocket closed by server before response.completed)';
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: msg } }),
  ].join('\n');
  const p = parseCodexStdout(stdout);
  assert.equal(p.turnFailed, msg);
});

test('parseCodexStdout requires turn.completed and usage', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'привет' },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 2 },
    }),
  ].join('\n');
  const p = parseCodexStdout(stdout);
  assert.equal(p.text, 'привет');
  assert.equal(p.threadId, '0199a213-81c0-7800-8aa1-bbab2a035a53');
  assert.equal(p.turnCompleted, true);
  assert.equal(p.usage.output_tokens, 3);
});

test('buildCodexExecArgs sets full access + never approvals + model/effort + http provider', () => {
  const args = buildCodexExecArgs({
    model: 'gpt-6.1-sol',
    effort: 'high',
    resumeId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
  });
  assert.ok(args.includes('danger-full-access'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('gpt-6.1-sol'));
  assert.ok(args.some((a) => String(a).includes('msb_http')));
  const resumeAt = args.indexOf('resume');
  assert.ok(resumeAt > 0);
  assert.equal(args[resumeAt + 1], '0199a213-81c0-7800-8aa1-bbab2a035a53');
  assert.equal(args.at(-1), '-');
});

test('native root config ignores profile and provider table scalars', () => {
  const s = parseCodexTomlScalars('model = "gpt-6.1-terra"\nmodel_reasoning_effort = "max"\n[profiles.test]\nmodel = "other"\nmodel_reasoning_effort = "low"\n');
  assert.equal(s.model, 'gpt-6.1-terra');
  assert.equal(s.model_reasoning_effort, 'max');
});
