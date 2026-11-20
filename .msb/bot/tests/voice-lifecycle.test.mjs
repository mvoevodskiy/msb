import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/voice-lifecycle.mjs', import.meta.url));
function run(scenario) {
  const child = spawnSync(process.execPath, [fixture, scenario], {
    env: { PATH: path.dirname(process.execPath), TMPDIR: os.tmpdir() },
    encoding: 'utf8', timeout: 9000,
  });
  assert.equal(child.status, 0, `Voice fixture ${scenario} failed:\n${child.stderr}\n${child.stdout}`);
  const row = child.stdout.split('\n').find(line => line.startsWith('VOICE_LIFECYCLE_RESULT='));
  assert.ok(row, `Missing voice lifecycle result: ${child.stdout}`);
  const r = JSON.parse(row.slice('VOICE_LIFECYCLE_RESULT='.length));
  assert.deepEqual(r.forbidden, [], 'The fixture must not use real network or processes.');
  assert.deepEqual(r.unhandled, [], 'Detached voice must handle every rejection.');
  assert.ok(r.events.includes('polling-started') && r.events.includes('stop-drained'), 'Exercise actual polling and drain the detached turn.');
  assert.deepEqual(r.timersAfterStop, { intervals: 0, timeouts: 0 }, 'Thinking, typing and initial preparation timers must be cleared.');
  assert.ok(r.cli.every(call => call.closed), 'All fake CLI processes must close.');
  assert.equal(r.authAfter, 'fixture-auth-unchanged');
  assert.equal(r.state.ccSessionId, 'saved-session');
  assert.equal(r.state.fixtureUnrelated, 'preserve-me');
  assert.ok(!r.deleted.includes(501), 'Never delete the original user voice message.');
  return r;
}
function eventIndex(r, event) {
  const index = r.events.indexOf(event); assert.notEqual(index, -1, `Missing event ${event}`); return index;
}
function assertStopped(r) {
  assert.equal(r.cli.length, 0, 'Cancellation before the model turn must prevent CLI spawn.');
  assert.equal(r.finalMessages[r.statusId], 'Моя остановочка ✋🏽⛔️');
  assert.equal(r.finalMessages[r.transcriptionId], undefined, 'No delayed preview may remain after cancellation cleanup.');
  assert.ok(r.deleted.includes(r.transcriptionId));
  assert.equal(r.envAfter, r.envBefore);
  assert.equal(r.calls.filter(call => call.text === '⏳ в очереди').length, 1, 'Accept into the queue while keeping the active I/O lock; the second stop clears this probe.');
  assert.ok(!r.calls.some(call => /voice-answer|❌/.test(call.text || '')), 'A cancelled voice must not publish success or an error.');
}

for (const stage of ['download', 'stt']) {
  test(`voice lifecycle: stop during ${stage} fences a late network response`, () => {
    const r = run(`stop-${stage}`);
    assertStopped(r);
    const held = r.fetches.find(call => call.stage === stage);
    assert.ok(held?.hasSignal && held.aborted && held.returned, 'The test must cancel and then deliver the held response.');
    assert.ok(eventIndex(r, `${stage}-started`) < eventIndex(r, 'stop-acknowledged'));
    assert.ok(eventIndex(r, 'stop-acknowledged') < eventIndex(r, `${stage}-returned`));
    assert.equal(r.fetches.filter(call => call.stage === 'stt').length, stage === 'download' ? 0 : 1);
    assert.ok(!r.events.includes('preview-dispatched'), 'No new transcript preview may start after network cancellation.');
  });
}

test('voice lifecycle: a delayed transcript edit is drained and deleted after stop', () => {
  const r = run('stop-preview');
  assertStopped(r);
  assert.ok(eventIndex(r, 'preview-dispatched') < eventIndex(r, 'stop-acknowledged'));
  assert.ok(eventIndex(r, 'stop-acknowledged') < eventIndex(r, 'preview-applied'));
  assert.ok(eventIndex(r, 'preview-applied') < eventIndex(r, 'transcription-deleted'));
  assert.equal(r.events.filter(event => event === 'preview-dispatched').length, 1, 'No replacement preview may start after stop.');
});

test('voice lifecycle: missing STT key shows original onboarding and its skip action works', () => {
  const r = run('missing-key');
  assert.equal(r.fetches.length + r.cli.length, 0, 'Missing configuration must fail before download or model work.');
  assert.ok(!r.calls.some(call => call.method === 'getFile'));
  const onboarding = r.calls.find(call => call.message_id === r.onboardingId && call.method === 'sendMessage');
  assert.equal(onboarding?.text, '🎙 Голосовые пока не настроены.\n\nПодключи Deepgram — при регистрации дают $200 баланса, хватит надолго. Нажми кнопку: останется перейти на сайт и вставить ключ.');
  assert.deepEqual(onboarding.reply_markup.inline_keyboard, [
    [{ text: '🎤 Подключить Deepgram', callback_data: 'settings:env:quick:DEEPGRAM_API_KEY' }],
    [{ text: 'Не сейчас', callback_data: 'whisper:skip' }],
  ]);
  assert.equal(onboarding.message_thread_id, 7);
  assert.ok(r.deleted.includes(r.statusId) && r.deleted.includes(r.transcriptionId));
  assert.equal(r.finalMessages[r.onboardingId], 'Когда захочешь — отправь голосовое снова.\nИли подключи Deepgram в /settings → 🔑');
  assert.equal(r.envAfter, r.envBefore);
});

test('voice lifecycle: transcript bypasses the pending env form and the next typed message still fills it', () => {
  const r = run('pending-env');
  assert.equal(r.cli.length, 1);
  assert.equal(r.cli[0].prompt, r.transcript, 'Send the full transcript directly to the agent.');
  assert.equal(r.envAfterVoice, r.envBefore, 'Speech must not be stored as a secret value.');
  assert.equal(r.keyAfterVoice, 'fixture-deepgram');
  assert.equal(r.envAfter, 'FIXTURE_KEEP=unchanged\nDEEPGRAM_API_KEY=fixture-typed-key\n');
  assert.ok(!r.calls.some(call => call.text?.includes('Перезапускаюсь')));
  assert.equal(r.fetches.filter(call => call.stage === 'download').length, 1);
  assert.equal(r.fetches.filter(call => call.stage === 'stt').length, 1);
});

test('voice lifecycle: a non-owner is ignored before status, download, transcription or CLI', () => {
  const r = run('non-owner');
  assert.deepEqual(r.beforeOwnerProbe, { calls: 0, fetches: 0, cli: 0 });
  assert.equal(r.fetches.length + r.cli.length, 0);
  assert.equal(r.envAfter, r.envBefore);
});
