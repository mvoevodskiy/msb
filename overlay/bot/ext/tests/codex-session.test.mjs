import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const id = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const sessionId = `ext:codex:${id}`;
const shim = fileURLToPath(new URL('../shim/run-turn.mjs', import.meta.url));

test('shim preserves session on failure/mismatch, resumes missing thread.started, and never replays a failed turn', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-shim-session-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  for (const part of ['bin', '.codex', '.msb/bots/default']) await fs.mkdir(path.join(home, part), { recursive: true });
  const store = { version: 1, active: 'codex', sessions: { codex: id }, models: { codex: 'gpt-6.1-terra' }, efforts: { codex: 'max' } };
  const storePath = path.join(home, '.msb/bots/default/ext-providers.json');
  await fs.writeFile(storePath, JSON.stringify(store));
  await fs.writeFile(path.join(home, '.codex/auth.json'), JSON.stringify({ tokens: { access_token: 'fake-test-token' } }));
  await fs.writeFile(path.join(home, 'bin/codex'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HOME + '/calls.jsonl', JSON.stringify(args) + '\\n');
const emit = (x) => console.log(JSON.stringify(x));
process.stdin.resume();
process.stdin.on('end', () => {
 if (process.env.FIXTURE_MODE === 'fail') {
  emit({type:'thread.started',thread_id:'${id}'});
  emit({type:'turn.failed',error:{message:'websocket closed before completion'}});
  process.exitCode=1;
 } else {
  if(process.env.FIXTURE_MODE==='mismatch') emit({type:'thread.started',thread_id:'0199a213-81c0-7800-8aa1-bbab2a035a54'});
  emit({type:'item.completed',item:{type:'agent_message',text:'fixture response'}});
  emit({type:'turn.completed',usage:{input_tokens:100,output_tokens:5,cached_input_tokens:80}});
 }
});
`, { mode: 0o755 });
  for (const mode of ['fail', 'mismatch', 'success']) {
    const before = await fs.readFile(storePath, 'utf8');
    const run = spawnSync(process.execPath, [shim, '-p', '--resume', sessionId], { cwd: home,
      env: { HOME: home, PATH: path.join(home, 'bin') + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin', FIXTURE_MODE: mode }, input: 'fixture', encoding: 'utf8' });
    const events = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
    const result = events.find((e) => e.type === 'result');
    assert.equal(result.session_id, sessionId);
    assert.equal(result.is_error, mode !== 'success');
    if (mode !== 'success') assert.equal(await fs.readFile(storePath, 'utf8'), before);
    else assert.equal(result.usage.input_tokens + result.usage.cache_read_input_tokens, 100);
  }
  const calls = (await fs.readFile(path.join(home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 3);
  for (const args of calls) {
    assert.ok(args.includes('model_reasoning_effort="max"'));
    assert.equal(args[args.indexOf('resume') + 1], id);
  }
});
