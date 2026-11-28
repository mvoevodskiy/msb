/**
 * Grok ACP spawn contract: `stdio` takes no extra flags.
 * `--no-auto-update` is a top-level flag and must precede `agent`.
 * A flag after `stdio` makes the CLI exit before initialize, which the bot
 * surfaces as "connection closed" while settings still show the login.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGrokAcpTurn } from '../adapters/grok-acp.mjs';

const session = 'bf4fd6ef-0ad8-46c3-9486-5422d21d7ac2';

const peer = `#!/usr/bin/env node
const readline = require('node:readline');
const args = process.argv.slice(2);
const stdioAt = args.indexOf('stdio');
const flagAfterStdio = stdioAt >= 0 && args.slice(stdioAt + 1).some(a => a.startsWith('--'));
const ordered = args[0] === '--no-auto-update' && args[1] === 'agent' && args.includes('stdio') && !flagAfterStdio;
if (!ordered) {
  process.stderr.write("error: unexpected argument '--no-auto-update' found\\n");
  process.exit(2);
}
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
const session = '${session}';
const reader = readline.createInterface({ input: process.stdin });
reader.on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === 'initialize') {
    return send({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion:1, agentCapabilities:{}, authMethods:[{id:'cached_token'}] } });
  }
  if (m.method === 'authenticate') return send({ jsonrpc:'2.0', id:m.id, result:{} });
  if (m.method === 'session/new' || m.method === 'session/load') {
    return send({ jsonrpc:'2.0', id:m.id, result:{ sessionId: session } });
  }
  if (m.method === 'session/prompt') {
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:session, update:{ sessionUpdate:'agent_message_chunk', content:{ type:'text', text:'PONG' } } } });
    send({ jsonrpc:'2.0', id:m.id, result:{ stopReason:'end_turn' } });
  }
});
`;

test('Grok ACP keeps --no-auto-update before agent stdio and completes the turn', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-acp-'));
  const bin = path.join(dir, 'grok');
  await fs.writeFile(bin, peer, { mode: 0o700 });
  try {
    const out = await runGrokAcpTurn({
      bin,
      cwd: dir,
      childEnv: { ...process.env, XAI_API_KEY: undefined },
      prompt: 'ping',
      timeoutMs: 5000,
      onSteerReady() {},
    });
    assert.equal(out.parsedOut.turnCompleted, true, out.parsedOut.turnFailed);
    assert.equal(out.parsedOut.text, 'PONG');
    assert.equal(out.parsedOut.sessionId, session);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
