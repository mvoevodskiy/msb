#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';

if (!globalThis[Symbol.for('msb.reference.networkBlocked')]) throw new Error('Network preload missing');
const role = process.argv[2] === 'descendant' ? 'descendant' : 'leader';
const trace = process.env.ABORT_TRACE;
const scenario = process.env.ABORT_CASE;
fs.appendFileSync(`${trace}.spawned`, `${role}\n`);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const record = (signal) => fs.appendFileSync(trace, `${JSON.stringify({ role, pid: process.pid, signal })}\n`);

// Even a broken runner cannot leave this fixture running indefinitely.
setTimeout(() => process.exit(0), 15000);
if (role === 'descendant') {
  process.on('SIGINT', () => record('SIGINT'));
  process.on('SIGTERM', () => record('SIGTERM'));
  setInterval(() => fs.appendFileSync(`${trace}.heartbeat`, '.'), 40);
  fs.writeFileSync(`${trace}.ready`, 'ready');
} else {
  process.stdin.resume();
  if (scenario === 'success') {
    emit({ type: 'system', subtype: 'init', session_id: 'reference-success' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'REFERENCE_SUCCESS' }],
      usage: { input_tokens: 7, output_tokens: 3 } } });
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'reference-success', total_cost_usd: 0.0123 });
    process.exit(0);
  }
  process.on('SIGINT', () => {
    record('SIGINT');
    if (scenario === 'cooperative') process.exit(0);
  });
  process.on('SIGTERM', () => { record('SIGTERM'); process.exit(0); });
  if (scenario === 'group') {
    const descendant = spawn(process.execPath, [process.argv[1], 'descendant'], {
      env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
    });
    const ready = setInterval(() => {
      if (!fs.existsSync(`${trace}.ready`)) return;
      clearInterval(ready);
      emit({ type: 'reference_ready', leaderPid: process.pid, descendantPid: descendant.pid });
    }, 10);
  } else {
    emit({ type: 'reference_ready', leaderPid: process.pid });
  }
}
