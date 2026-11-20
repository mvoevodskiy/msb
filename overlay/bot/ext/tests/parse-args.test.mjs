import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeArgv, providerRuntimeOverride, buildPrompt } from '../adapters/parse-args.mjs';

test('parseClaudeArgv extracts model resume and system prompt', () => {
  const p = parseClaudeArgv([
    '-p',
    '--output-format',
    'stream-json',
    '--model',
    'claude-opus-4-7',
    '--resume',
    'sess-1',
    '--append-system-prompt',
    'SYS',
    '--permission-mode',
    'bypassPermissions',
  ]);
  assert.equal(p.model, 'claude-opus-4-7');
  assert.equal(p.resume, 'sess-1');
  assert.equal(p.appendSystemPrompt, 'SYS');
  assert.equal(p.permissionMode, 'bypassPermissions');
});

test('providerRuntimeOverride corrects Claude Max template for cursor', () => {
  const text = providerRuntimeOverride('cursor');
  assert.match(text, /Cursor/);
  assert.match(text, /НЕ через Claude Code/);
  assert.equal(providerRuntimeOverride('claude'), '');
});

test('buildPrompt puts runtime override first', async () => {
  const prompt = await buildPrompt(
    { appendSystemPrompt: 'Этот бот: Claude Code, работает по подписке Claude Max' },
    'кто ты',
    { providerId: 'cursor' },
  );
  const idxOverride = prompt.indexOf('Runtime override');
  const idxTemplate = prompt.indexOf('Claude Max');
  assert.ok(idxOverride >= 0 && idxOverride < idxTemplate);
});
