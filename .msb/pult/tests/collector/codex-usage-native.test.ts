// Real pinned ccusage against synthetic sessions only; opt in with PULT_TEST_CCUSAGE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexUsageReader } from '../../src/collector/sources/codex-usage.ts';

test('native ccusage selects the bot session and excludes an unrelated session',
  { skip: !process.env.PULT_TEST_CCUSAGE }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'pult-real-ccusage-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'codex'), sessions = join(home, 'sessions/2026/11/20'), bot = join(root, 'bots/default');
    await mkdir(sessions, { recursive: true });
    await mkdir(bot, { recursive: true });
    const one = '0199a213-81c0-7800-8aa1-bbab2a035a53', other = '0199a213-81c0-7800-8aa1-bbab2a035a54';
    await writeFile(join(bot, 'state.json'), JSON.stringify({ extAuthBypass: 'codex', ccSessionId: 'ext:codex:' + one }));
    for (const [id, input] of [[one, 10], [other, 20]] as const) {
      const timestamp = '2026-11-20T12:00:00.000Z';
      const usage = { input_tokens: input, cached_input_tokens: 2, cache_write_input_tokens: 0,
        output_tokens: 3, reasoning_output_tokens: 0, total_tokens: input + 3 };
      const lines = [{ timestamp, type: 'session_meta', payload: { id, source: 'exec' } },
        { timestamp, type: 'turn_context', payload: { model: 'gpt-5.4' } },
        { timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } } }];
      await writeFile(join(sessions, `rollout-2026-11-20T12-00-00-${id}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    }
    const env = { HOME: process.env.HOME, CODEX_HOME: home, PULT_CCUSAGE_BIN: process.env.PULT_TEST_CCUSAGE, PATH: process.env.PATH };
    const reader = new CodexUsageReader(env, join(root, 'bots'));
    const result = await reader.collect([{ id: 'default', directory: bot }], 'UTC', new Date('2026-11-21T12:00:00Z'));
    assert.equal(result.failed, false);
    assert.deepEqual([result.usage.get('default')?.week, result.usage.get('default')?.month,
      result.usage.get('default')?.all], [13, 13, 13]);
  });
