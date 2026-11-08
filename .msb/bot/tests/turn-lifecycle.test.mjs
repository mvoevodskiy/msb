import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/turn-lifecycle.mjs', import.meta.url));
const stopped = 'Моя остановочка ✋🏽⛔️';

function run(scenario) {
  const child = spawnSync(process.execPath, [fixture, scenario], {
    env: { PATH: path.dirname(process.execPath), TMPDIR: os.tmpdir() },
    encoding: 'utf8', timeout: 8000,
  });
  assert.equal(child.status, 0, `Lifecycle fixture ${scenario} failed:\n${child.stderr}\n${child.stdout}`);
  const row = child.stdout.split('\n').find((line) => line.startsWith('LIFECYCLE_RESULT='));
  assert.ok(row, `Missing fixture report: ${child.stdout}`);
  const report = JSON.parse(row.slice('LIFECYCLE_RESULT='.length));
  assert.deepEqual(report.unhandled, [], 'Detached turn must not leave an unhandled rejection.');
  assert.deepEqual(report.forbidden, [], 'No external network or unexpected process is allowed.');
  assert.equal(report.activeChildren, 0, 'Read the outcome only after all CLI fixtures have closed.');
  assert.ok(report.events.includes('polling-started'), 'Exercise actual bot.start() polling, not concurrent handleUpdate calls.');
  assert.ok(report.events.includes('stop-drained'), 'The stop wrapper must finish before state and delivery are inspected.');
  assert.ok(report.calls.some(call => call.text === 'Нечего останавливать 🤷'), 'Preserve the original idle stop response.');
  assert.equal(report.intervalsAfterStop, 0, 'No progress/typing interval may survive the drained stop.');
  assert.equal(new Set(report.history.map(row => row.turnId)).size, report.history.length, 'one terminal journal record per turn');
  assert.ok(report.history.every(row => ['ok', 'aborted', 'error'].includes(row.status)));
  for (const row of report.history.filter(row => row.status === 'ok')) {
    assert.equal(row.providerId, report.cli.find(call => call.prompt === row.query)?.provider, 'History follows the actual selected CLI');
  }
  return report;
}

function assertAnswerReplacedStatus(report, number) {
  const cli = report.cli.find((entry) => entry.number === number);
  assert.ok(cli?.statusMessageId, 'Associate the answer with its own original status message.');
  const answers = report.calls.filter((call) => call.applied && new RegExp(`^success-${number}(?:\\n|$)`).test(call.text));
  assert.equal(answers.length, 1, 'Deliver the completed answer once.');
  const answer = answers[0];
  assert.equal(answer.method, 'editMessageText');
  assert.equal(answer.messageId, cli.statusMessageId);
  assert.equal(answer.parseMode, 'HTML');
  assert.match(answer.text, new RegExp(`^success-${number}\\n\\n<blockquote>⏱ \\d+\\.\\ds</blockquote>$`));
  assert.equal(report.finalMessages[cli.statusMessageId], answer.text, 'Late progress must not overwrite the answer.');
}

test('turn lifecycle: early stop avoids spawn; failed initial status does not strand the next turn', () => {
  const early = run('early-stop');
  assert.equal(early.history[0].providerId, null, 'no provider claimed before any CLI marker');
  assert.equal(early.cli.length, 0, 'An aborted request must not spawn CLI after its delayed status resolves.');
  assert.ok(early.events.indexOf('stop-delivered') < early.events.indexOf('initial-status-released'));
  assert.equal(early.finalMessages[early.initialStatusId], stopped);

  const failed = run('status-failure');
  assert.deepEqual(failed.cli.map((call) => call.prompt), ['after failed status']);
  assert.ok(failed.calls.some((call) => call.text?.includes('fixture initial status failed')));
  assertAnswerReplacedStatus(failed, 1);
});

test('turn lifecycle: an in-flight progress edit finishes before the terminal stopped edit', () => {
  const r = run('late-edit');
  const order = (event) => { const index = r.events.indexOf(event); assert.notEqual(index, -1, `Missing ${event}`); return index; };
  assert.ok(order('progress-edit-dispatched') < order('cli-abort:1'));
  assert.ok(order('cli-abort:1') < order('progress-edit-applied'));
  assert.ok(order('progress-edit-applied') < order('stopped-edit-applied'));
  assert.ok(r.calls.some((call) => call.method === 'editMessageText'
    && call.messageId === r.initialStatusId && call.text === 'Думаю… ⏳' && call.applied),
  'The deliberately delayed edit must be the original thinking frame, not a model label.');
  assert.equal(r.finalMessages[r.initialStatusId], stopped, 'Late progress must not replace the terminal state.');
  assert.ok(!r.calls.some((call) => call.text === '✅'), 'Cancellation must never report success.');
});

test('turn lifecycle: stop holds the lock through delayed CLI close, then admits exactly one next turn', () => {
  const r = run('next-turn');
  assert.deepEqual(r.cli.map((call) => call.prompt), ['first task', 'second allowed']);
  assert.equal(r.maxActiveChildren, 1, 'The next CLI must not overlap the stopped process.');
  assert.ok(r.events.indexOf('cli-close:1') < r.events.indexOf('cli-start:2'));
  assert.ok([1, 2].includes(r.calls.filter((call) => call.text === '⏳ в очереди').length), 'The early probe queues; the allowed replacement may also queue while the old journal finishes.');
  assert.equal(r.calls.filter((call) => call.text?.startsWith('Уже работаю')).length, 1, 'Compaction still cannot overlap the replacement CLI.');
  assert.ok(r.events.includes('cli-abort:1'));
  assert.ok(!r.events.includes('cli-abort:2'), 'Finishing the old turn must not disturb the replacement turn.');
  assertAnswerReplacedStatus(r, 2);
});

test('turn lifecycle: an aborted CLI session never replaces or creates the saved conversation', () => {
  for (const scenario of ['saved-session', 'empty-session']) {
    const r = run(scenario);
    assert.equal(r.cli.length, 1);
    assert.ok(r.events.includes('cli-init:1'), 'The fake CLI must publish its different native session before cancellation.');
    assert.ok(r.events.includes('cli-late-result:1'), 'Also cover a successful result racing with cancellation.');
    assert.equal(r.state.ccSessionId, scenario === 'saved-session' ? 'saved-session-A' : undefined);
    assert.equal(r.state.fixtureUnrelated, 'preserve-me');
    assert.equal(r.finalMessages[r.initialStatusId], stopped);
    assert.ok(!r.calls.some((call) => /^success-1(?:\n|$)/.test(call.text)), 'Do not publish the late successful result after cancellation.');
  }
});

test('turn lifecycle: newtask during the first turn prevents its late session ID from returning', () => {
  const r = run('reset-session');
  assert.equal(r.cli.length, 1);
  assert.ok(r.events.indexOf('reset-acknowledged') < r.events.indexOf('cli-late-result:1'));
  assert.equal(r.state.ccSessionId, undefined);
  assert.equal(r.state.sessionEpoch, 1);
  assert.equal(r.state.fixtureUnrelated, 'preserve-me');
  assertAnswerReplacedStatus(r, 1);
});

test('turn lifecycle: a late turn cannot replace the session after switching away and back', () => {
  const r = run('provider-roundtrip');
  assert.ok(r.events.indexOf('provider-roundtrip-completed') < r.events.indexOf('cli-late-result:1'));
  assert.equal(r.state.ccSessionId, 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53');
  assert.equal(r.state.parkedCcSessions.claude, 'saved-claude-session');
  assert.equal(r.state.sessionEpoch, 2);
  assert.equal(r.cli[0].provider, 'codex', 'Pass the provider selected at turn start to the CLI');
});

test('turn lifecycle: /newtask stays reset across provider switches and a late turn', () => {
  const r = run('provider-reset');
  assert.ok(r.events.includes('reset-acknowledged'));
  assert.ok(r.events.indexOf('provider-roundtrip-completed') < r.events.indexOf('cli-late-result:1'));
  assert.equal(r.state.ccSessionId, undefined);
  assert.equal(r.state.parkedCcSessions.claude, 'saved-claude-session');
  assert.equal(r.state.sessionEpoch, 3);
});

test('turn lifecycle: /clear stays reset across provider switches and a late turn', () => {
  const r = run('provider-clear');
  assert.ok(r.events.includes('reset-acknowledged'));
  assert.ok(r.events.indexOf('provider-roundtrip-completed') < r.events.indexOf('cli-late-result:1'));
  assert.equal(r.state.ccSessionId, undefined);
  assert.equal(r.state.parkedCcSessions.claude, 'saved-claude-session');
  assert.equal(r.state.sessionEpoch, 3);
});
