#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

if (!globalThis[Symbol.for('msb.reference.networkBlocked')]) {
  throw new Error('The fake CLI must inherit the network-deny preload');
}
const name = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
if (name === 'claude' && argv.length === 1 && argv[0] === '--version') {
  process.stdout.write('2.1.154 (Claude Code)');
  process.exit(0);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString('utf8');
const traceFile = process.env.REFERENCE_TRACE;
await fs.appendFile(traceFile, `${JSON.stringify({ name, argv, stdin })}\n`);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const otherThread = '0299a213-81c0-7800-8aa1-bbab2a035a53';
const scenario = process.env.REFERENCE_SCENARIO || '';

if (name === 'claude') {
  emit({ type: 'system', subtype: 'init', session_id: 'reference-claude-session' });
  emit({ type: 'result', subtype: 'success', result: 'CLAUDE_REFERENCE_OK' });
} else if (name === 'codex' && argv[0] === 'login' && argv[1] === 'status') {
  const valid = process.env.REFERENCE_LOGIN !== 'invalid';
  process.stderr.write(valid ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
  process.exitCode = valid ? 0 : 1;
} else if (name === 'codex' && argv[0] === 'exec' && process.env.REFERENCE_SCENARIO === 'codex-first-stop') {
  process.once('SIGINT', () => {
    writeFileSync(path.join(process.env.HOME, 'reference-native-stopped'), 'yes');
    process.exit(130);
  });
  const started = JSON.stringify({ type: 'thread.started', thread_id: thread });
  await new Promise(resolve => process.stdout.write(started.slice(0, 9), resolve));
  await new Promise(resolve => setTimeout(resolve, 20));
  await new Promise(resolve => process.stdout.write(started.slice(9) + '\r\n', resolve));
  await fs.writeFile(path.join(process.env.HOME, 'reference-native-started'), 'yes');
  setInterval(() => {}, 60_000);
} else if (name === 'codex' && argv[0] === 'exec' && scenario.startsWith('codex-partial-')) {
  emit({ type: 'thread.started', thread_id: scenario.endsWith('-mismatch') ? otherThread : thread });
  const message = text => emit({ type: 'item.completed', item: { type: 'agent_message', text } });
  message('Первый фрагмент');
  message('Второй фрагмент');
  if (scenario.endsWith('-resume')) {
    message('[КНОПКИ: plan]\n\n[INSTALL_SKILL]{"name":"failed-turn-skill","description":"Fixture skill","body":"draft"}[/INSTALL_SKILL]');
  }
  if (scenario.endsWith('-metered')) {
    const file = path.join(process.env.HOME, '.codex', 'sessions', 'rollout-fixture-' + thread + '.jsonl');
    const sample = { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count',
      info: { model_context_window: 1000, last_token_usage: { total_tokens: 520 } } } };
    await fs.appendFile(file, JSON.stringify(sample) + '\n');
  }
  if (!scenario.endsWith('-resume')) emit({ type: 'turn.failed', error: { message: scenario.endsWith('-transport')
    ? 'websocket closed before completion' : 'Ordinary native fixture failure' } });
  process.exitCode = 1;
} else if (name === 'codex' && argv[0] === 'exec') {
  const calls = (await fs.readFile(traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.name === 'codex' && entry.argv[0] === 'exec');
  const streamCut = process.env.REFERENCE_SCENARIO === 'stream-cut';
  if (streamCut) await fs.appendFile(process.env.REFERENCE_EFFECTS, 'tool-operation\n');
  const retry = streamCut && calls.length > 1;
  emit({ type: 'thread.started', thread_id: retry ? otherThread : thread });
  if (retry) {
    // An erroneous replay can appear to succeed while repeating a prior effect.
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 'REPLAY_COMPLETED' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
  } else {
    emit({ type: 'turn.failed', error: { message: streamCut
      ? 'stream disconnected before completion: websocket closed by server'
      : 'Reference model unavailable' } });
    process.exitCode = 1;
  }
} else {
  process.stderr.write(`Unexpected fake CLI invocation: ${name} ${argv.join(' ')}\n`);
  process.exitCode = 90;
}
