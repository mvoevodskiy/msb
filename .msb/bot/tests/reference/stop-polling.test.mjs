import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Desired old lifecycle: command intake remains available while a task runs.
// The fixture deliberately uses bot.start(), not concurrent handleUpdate calls.
test('reference: /stop reaches and aborts the running CLI through normal polling', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/stop-polling.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '/tmp' }, encoding: 'utf8', timeout: 6000,
  });
  assert.equal(run.status, 0, `Harness must complete: ${run.stderr}\n${run.stdout}`);
  const line = run.stdout.split('\n').find(x => x.startsWith('REFERENCE_RESULT='));
  assert.ok(line, 'Harness report missing');
  const report = JSON.parse(line.slice('REFERENCE_RESULT='.length));
  assert.ok(report.events.includes('cli-start'), 'Positive control: real core must launch the fake CLI');
  assert.ok(report.events.includes('stop-delivered'), 'Positive control: polling must deliver /stop');
  assert.ok(report.events.indexOf('stop-delivered') < report.events.indexOf('cli-close'),
    `Command must arrive before task completion; observed ${report.events.join(' → ')}`);
  assert.ok(report.events.includes('cli-abort'), 'Stop must reach the CLI');
  assert.ok(report.calls.some(x => x.text === 'Моя остановочка ✋🏽⛔️'), 'Original stop text');
  assert.ok(!report.calls.some(x => x.text === '✅'), 'No success tick after cancellation');
});
