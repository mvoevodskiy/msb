#!/usr/bin/env node
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

if (name === 'claude') {
  emit({ type: 'system', subtype: 'init', session_id: 'reference-claude-session' });
  emit({ type: 'result', subtype: 'success', result: 'CLAUDE_REFERENCE_OK' });
} else if (name === 'codex' && argv[0] === 'login' && argv[1] === 'status') {
  const valid = process.env.REFERENCE_LOGIN !== 'invalid';
  process.stderr.write(valid ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
  process.exitCode = valid ? 0 : 1;
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
