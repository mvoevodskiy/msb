/** Fake ACP peer: second session/prompt cancels the first (Cursor send-now). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCursorAcpTurn } from '../adapters/cursor-acp.mjs';

const session = '11111111-1111-4111-8111-111111111111';

const peer = `#!/usr/bin/env node
const readline = require('node:readline');
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
const session = '${session}';
let firstPromptId = null;
const reader = readline.createInterface({ input: process.stdin });
reader.on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === 'initialize') return send({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion:1, agentCapabilities:{}, authMethods:[{id:'cursor_login'}] } });
  if (m.method === 'authenticate') return send({ jsonrpc:'2.0', id:m.id, result:{} });
  if (m.method === 'session/new' || m.method === 'session/load') return send({ jsonrpc:'2.0', id:m.id, result:{ sessionId: session } });
  if (m.method === 'session/prompt') {
    const text = (m.params?.prompt || []).map(p => p.text).join('');
    if (firstPromptId == null) {
      firstPromptId = m.id;
      send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:session, update:{ sessionUpdate:'tool_call', toolCallId:'t1', title:'sleep' } } });
      return;
    }
    // Send-now: cancel the original turn, complete the steer.
    send({ jsonrpc:'2.0', id:firstPromptId, result:{ stopReason:'cancelled' } });
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:session, update:{ sessionUpdate:'agent_message_chunk', content:{ type:'text', text: text.includes('STEER') ? 'STEERED_OK' : 'NEXT' } } } });
    send({ jsonrpc:'2.0', id:m.id, result:{ stopReason:'end_turn' } });
  }
});
`;

test('Cursor ACP steer send-now accepts and replaces turn text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-acp-'));
  const bin = path.join(dir, 'agent');
  await fs.writeFile(bin, peer, { mode: 0o700 });
  let handle;
  let status;
  try {
    const out = await runCursorAcpTurn({
      bin,
      cwd: dir,
      childEnv: { ...process.env },
      prompt: 'do work',
      timeoutMs: 5000,
      onSteerReady: (h) => {
        if (!h) return;
        handle = h;
        setTimeout(() => {
          h.steer('STEER now').then((r) => { status = r.status; });
        }, 20);
      },
    });
    assert.equal(status, 'accepted');
    assert.equal(out.parsedOut.turnCompleted, true);
    assert.match(out.parsedOut.text, /STEERED_OK/);
    assert.equal(out.parsedOut.sessionId, session);
    assert.deepEqual(await handle.steer('late'), { status: 'rejected' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** session/load replays prior agent_message_chunk; reply must ignore them. */
const peerReplay = `#!/usr/bin/env node
const readline = require('node:readline');
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
const session = '${session}';
const reader = readline.createInterface({ input: process.stdin });
reader.on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === 'initialize') return send({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion:1, agentCapabilities:{}, authMethods:[{id:'cursor_login'}] } });
  if (m.method === 'authenticate') return send({ jsonrpc:'2.0', id:m.id, result:{} });
  if (m.method === 'session/load') {
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:session, update:{ sessionUpdate:'agent_message_chunk', content:{ type:'text', text:'OLD_REPLY_1\\n' } } } });
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:session, update:{ sessionUpdate:'agent_message_chunk', content:{ type:'text', text:'OLD_REPLY_2\\n' } } } });
    return send({ jsonrpc:'2.0', id:m.id, result:{ sessionId: session } });
  }
  if (m.method === 'session/new') return send({ jsonrpc:'2.0', id:m.id, result:{ sessionId: session } });
  if (m.method === 'session/prompt') {
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:session, update:{ sessionUpdate:'agent_message_chunk', content:{ type:'text', text:'ONLY_NEW' } } } });
    return send({ jsonrpc:'2.0', id:m.id, result:{ stopReason:'end_turn' } });
  }
});
`;

test('Cursor ACP ignores session/load transcript replay in reply text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-acp-replay-'));
  const bin = path.join(dir, 'agent');
  await fs.writeFile(bin, peerReplay, { mode: 0o700 });
  try {
    const out = await runCursorAcpTurn({
      bin,
      cwd: dir,
      childEnv: { ...process.env },
      resumeId: session,
      prompt: 'short ask',
      timeoutMs: 5000,
      onSteerReady: () => {},
    });
    assert.equal(out.parsedOut.turnCompleted, true);
    assert.equal(out.parsedOut.text, 'ONLY_NEW');
    assert.doesNotMatch(out.parsedOut.text, /OLD_REPLY/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
