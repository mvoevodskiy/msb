import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runClaudeTurn } from '../src/agent/claude.mjs';

const fakeCli = `#!${process.execPath}
const net = require('node:net');
const emit = x => process.stdout.write(JSON.stringify(x) + '\\n');
const provider = process.env.MSB_TURN_PROVIDER || 'claude';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buf += chunk; });
function finishClaude() {
  emit({ type: 'system', subtype: 'provider', provider_id: provider });
  if (process.env.MSB_CODEX_STEER_FD) process.exit(9);
  const steered = buf.includes('correct now');
  emit({ type: 'result', subtype: 'success', session_id: 'claude-fixture',
    result: steered ? 'claude-steered' : 'claude-ok', is_error: false });
  process.exit(0);
}
if (provider === 'claude') {
  // stream-json input stays open for mid-turn steer; close or second user ends the turn.
  const tryParse = () => {
    const lines = buf.split('\\n').filter(Boolean);
    if (lines.some(l => { try { return JSON.parse(l).message?.content?.[0]?.text === 'correct now'; } catch { return false; } })) {
      finishClaude();
    }
  };
  process.stdin.on('data', tryParse);
  process.stdin.on('end', finishClaude);
  setTimeout(finishClaude, 200);
} else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    emit({ type: 'system', subtype: 'provider', provider_id: provider });
    if (provider !== 'codex' && provider !== 'cursor' && provider !== 'grok') {
      if (process.env.MSB_CODEX_STEER_FD) process.exit(9);
      emit({ type: 'result', subtype: 'success', session_id: 'other-fixture', result: 'other-ok', is_error: false });
      return;
    }
    if (process.env.MSB_CODEX_STEER_FD !== '3') process.exit(10);
    const socket = new net.Socket({ fd: 3, readable: true, writable: true });
    socket.setEncoding('utf8');
    socket.write(JSON.stringify({ type: 'ready', threadId: 'fixture-thread', turnId: 'fixture-turn' }) + '\\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\\n');
      if (newline < 0) return;
      const msg = JSON.parse(buffer.slice(0, newline));
      if (msg.text !== 'correct now' || msg.threadId !== 'fixture-thread' || msg.turnId !== 'fixture-turn') process.exit(11);
      socket.write(JSON.stringify({ type: 'result', id: msg.id, status: 'accepted' }) + '\\n', () => {
        emit({ type: 'result', subtype: 'success', session_id: 'ext:' + provider + ':fixture-session', result: provider + '-ok', is_error: false });
        socket.end(() => process.exit(0));
      });
    });
  });
}
`;

async function withFakeCli(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-steer-envelope-'));
  const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'claude'), fakeCli, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  t.after(async () => { process.env.PATH = previous; await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test('Codex turn exposes a private bidirectional control pipe and retains the result', async t => {
  const cwd = await withFakeCli(t);
  let found;
  const ready = new Promise(resolve => { found = resolve; });
  const result = runClaudeTurn({ cwd, prompt: 'fixture', providerId: 'codex', onSteerReady: handle => {
    if (handle) found(handle);
  } });
  const handle = await ready;
  assert.deepEqual(await handle.steer('correct now'), { status: 'accepted' });
  const response = await result;
  assert.equal(response.text, 'codex-ok');
  assert.equal(response.providerId, 'codex');
  assert.equal(response.isError, false);
  assert.equal(handle.active, false);
});

test('Claude exposes stdin stream-json steering and accepts a correction', async t => {
  const cwd = await withFakeCli(t);
  let found;
  const ready = new Promise(resolve => { found = resolve; });
  const result = runClaudeTurn({ cwd, prompt: 'fixture', providerId: 'claude', onSteerReady: handle => {
    if (handle) found(handle);
  } });
  const handle = await ready;
  assert.deepEqual(await handle.steer('correct now'), { status: 'accepted' });
  const response = await result;
  assert.equal(response.text, 'claude-steered');
  assert.equal(response.providerId, 'claude');
  assert.equal(handle.active, false);
});

test('Cursor overlay turn opens the same steer control fd as Codex', async t => {
  const cwd = await withFakeCli(t);
  let found;
  const ready = new Promise(resolve => { found = resolve; });
  const result = runClaudeTurn({ cwd, prompt: 'fixture', providerId: 'cursor', onSteerReady: handle => {
    if (handle) found(handle);
  } });
  const handle = await ready;
  assert.deepEqual(await handle.steer('correct now'), { status: 'accepted' });
  const response = await result;
  assert.equal(response.text, 'cursor-ok');
  assert.equal(response.providerId, 'cursor');
});

test('Qwen does not open a steer control fd', async t => {
  const cwd = await withFakeCli(t);
  const notices = [];
  const response = await runClaudeTurn({
    cwd, prompt: 'fixture', providerId: 'qwen',
    onSteerReady: value => notices.push(value),
  });
  assert.equal(response.text, 'other-ok');
  assert.deepEqual(notices, []);
});
