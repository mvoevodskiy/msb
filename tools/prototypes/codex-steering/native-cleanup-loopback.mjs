/** Real detached-child cleanup probe. Run only in a disposable container. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { NativeSession } from './session.mjs';

assert.ok(fs.existsSync('/.dockerenv'), 'run only in a disposable container');
const program = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 1500)'], { stdio: 'ignore' });
  child.unref();
  process.stdout.write('fixture-started\\n', () => process.exit(0));
`;
const child = spawn(process.execPath, ['-e', program], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
const session = new NativeSession(child, { timeoutMs: 1000, closeGraceMs: 100 });
const closed = new Promise(resolve => child.once('close', resolve));
try {
  await closed;
  await assert.rejects(session.close(), /group still has running members/);
  console.log(JSON.stringify({ detached_same_group_child_detected: true, test_container_only: true }));
} finally {
  // The fixture child exits itself. Never signal a group after its leader has
  // exited: container detection alone does not prove a separate PID namespace.
  await new Promise(resolve => setTimeout(resolve, 1600));
}
