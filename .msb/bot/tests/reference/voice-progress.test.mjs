import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Behavioral reference: master 00f081f2220d0e6d3a186e8e1bb447b57acd6ebf.
// Assertions below pin the reviewed behavior; the removed closed bundle is not a test dependency.
// vendor/deobfuscated.js: 102108–102241 (STT), 119871–119990 (voice),
// 109960–110060 / 106170+ (progress), 3297–3384 (footer).
// Historical source blob: 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11 (see README).
const harness = fileURLToPath(new URL('./fixtures/voice-progress-harness.mjs', import.meta.url));
const marker = 'MSB_REFERENCE_RESULT=';
const transcript = 'Проверь <сервис> & очередь. ' + 'Это полный текст голосовой задачи. '.repeat(12) + 'КОНЕЦ_ПОЛНОЙ_ТРАНСКРИПЦИИ';
const answer = 'Эталонный ответ на задачу.';
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function runScenario(t, scenario) {
  const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-reference-voice-progress-'));
  t.after(() => fs.rm(fixtureHome, { recursive: true, force: true }));
  const result = await new Promise((resolve, reject) => {
    // An allowlist, not {...process.env}: no real credentials, HOME or agent state.
    const child = spawn(process.execPath, [harness, scenario], {
      cwd: fixtureHome,
      env: {
        HOME: fixtureHome,
        TMPDIR: fixtureHome,
        PATH: path.dirname(process.execPath),
        BOT_TOKEN: '42:reference-fixture-only',
        ADMIN_ID: '42',
        MSB_BOT_ID: 'default',
        MSB_SESSION_DIR: path.join(fixtureHome, '.msb/bots/default/sessions'),
        MSB_WORKSPACE_DIR: path.join(fixtureHome, 'workspace'),
        REFERENCE_FIXTURE: 'voice-progress',
        REFERENCE_TRANSCRIPT: transcript,
        REFERENCE_ANSWER: answer,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let expired = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => { stdout += text; });
    child.stderr.on('data', (text) => { stderr += text; });
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 20_000);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (expired || code !== 0) {
        reject(new Error(`Isolated harness failed (code=${code}, signal=${signal}): ${stderr.slice(-3500)}\n${stdout.slice(-1500)}`));
        return;
      }
      const row = stdout.split('\n').find((line) => line.startsWith(marker));
      if (!row) { reject(new Error(`Harness emitted no result: ${stdout}\n${stderr}`)); return; }
      resolve(JSON.parse(row.slice(marker.length)));
    });
  });
  assert.deepEqual(result.forbiddenNetwork, [], 'The fixture attempted real network access.');
  assert.deepEqual(result.forbiddenProcesses, [], 'The fixture attempted an unexpected OS process.');
  assert.equal(result.pollingStarted, false, 'Reference tests must not start Telegram polling.');
  return result;
}

function expectContract(violations, condition, description) {
  if (!condition) violations.push(description);
}

test('reference voice: shared Deepgram key, original transcript preview and full prompt reach the real core turn', { timeout: 25_000 }, async (t) => {
  const r = await runScenario(t, 'voice');
  const failures = [];
  const downloads = r.fetches.filter((call) => call.url.startsWith('https://api.telegram.org/file/'));
  const stt = r.fetches.filter((call) => call.url.startsWith('https://api.deepgram.com/v1/listen'));
  const messages = r.api.filter((call) => ['sendMessage', 'editMessageText'].includes(call.method));
  const expectedPreview = `<blockquote>${escapeHtml(transcript.slice(0, 300) + '...')}</blockquote>\n🎙 •~•~•~•~•~•~•~•~•~•~•`;
  expectContract(failures, downloads.length === 1, 'voice must download the Telegram OGG exactly once');
  expectContract(failures, stt.length === 1, 'voice must call Deepgram exactly once using the shared .msb/.env key');
  if (stt.length === 1) {
    const call = stt[0];
    const url = new URL(call.url);
    expectContract(failures, call.method === 'POST', 'Deepgram request must be POST');
    expectContract(failures, url.searchParams.get('model') === 'nova-3', 'Deepgram model must remain nova-3');
    expectContract(failures, url.searchParams.get('language') === 'ru', 'the default STT language must remain ru');
    expectContract(failures, url.searchParams.get('smart_format') === 'true' && url.searchParams.get('punctuate') === 'true', 'Deepgram formatting/punctuation must remain enabled');
    expectContract(failures, call.headers.authorization === 'Token fixture-deepgram-only', 'the shared key must reach Deepgram without reauthorization');
    expectContract(failures, call.headers['content-type'] === 'audio/ogg', 'voice must retain audio/ogg content type');
    expectContract(failures, JSON.stringify(call.bytes) === JSON.stringify([79, 103, 103, 83]), 'the downloaded voice bytes must reach STT unchanged');
    expectContract(failures, call.hasAbortSignal && downloads[0]?.hasAbortSignal, 'download and transcription must both have timeout/cancellation signals');
  }
  const initial = messages.find((call) => call.method === 'sendMessage' && call.payload.text === '🎙 Расшифровываю...');
  expectContract(failures, Boolean(initial), 'show the original transcription status, without a new interface');
  expectContract(failures, messages.some((call) => call.method === 'editMessageText' && call.payload.text === expectedPreview && call.payload.parse_mode === 'HTML' && call.payload.message_id === initial?.resultMessageId), 'edit that status into the original 300-character blockquote and microphone wave');
  expectContract(failures, initial?.payload.message_thread_id === 7, 'the transcription status must remain in the source Telegram topic');
  expectContract(failures, !r.api.some((call) => call.method === 'deleteMessage' && call.payload.message_id === 501), 'retain the original voice message');
  expectContract(failures, r.cli.length === 1, 'the real core agent runner must receive one voice-derived request');
  if (r.cli.length === 1) {
    expectContract(failures, r.cli[0].prompt.endsWith(transcript), 'send the FULL transcript, not the 300-character preview, to the model');
    expectContract(failures, r.cli[0].prompt.includes('Это исходное сообщение для голосового ответа.'), 'preserve the original replied-to message as context');
  }
  expectContract(failures, messages.some((call) => String(call.payload.text || '').includes(answer)), 'deliver the agent response after transcription');
  assert.deepEqual(failures, [], `Missing old voice behavior:\n- ${failures.join('\n- ')}`);
});

test('reference progress: a delayed real text turn keeps typing/rotating status and finishes with the old footer, not a lone checkmark', { timeout: 25_000 }, async (t) => {
  const r = await runScenario(t, 'progress');
  assert.equal(r.cli.length, 1, 'The delayed fixture must actually exercise the core CLI path.');
  assert.equal(r.cli[0].prompt, 'Задача для проверки индикации.');
  const failures = [];
  const typing = r.api.filter((call) => call.method === 'sendChatAction' && call.payload.action === 'typing');
  const messages = r.api.filter((call) => ['sendMessage', 'editMessageText'].includes(call.method));
  const initial = messages.find((call) => call.method === 'sendMessage' && call.payload.text === 'Думаю ⏳');
  // vendor Q4A/thinkingText: compare real frame identities, not changing elapsed seconds.
  const frames = ['Думаю… ⏳', 'Думаю… ⌛️', 'Соображаю… 🤔', 'Мозгую… 🧠', 'Формулирую… 🧐'];
  const observedFrames = messages.map((call) => frames.findIndex((frame) => String(call.payload.text || '').startsWith(frame)))
    .filter((index) => index >= 0)
    .filter((index, position, values) => position === 0 || index !== values[position - 1]);
  const response = messages.findLast((call) => String(call.payload.text || '').includes(answer));
  expectContract(failures, Boolean(initial), 'start with the original «Думаю ⏳» status');
  expectContract(failures, typing.length >= 2 && typing.at(-1).at - typing[0].at >= 3500, 'send typing immediately and refresh it during the delayed request');
  expectContract(failures, JSON.stringify(observedFrames.slice(0, 3)) === '[0,1,2]', 'rotate the old «Думаю… ⏳» → «Думаю… ⌛️» → «Соображаю… 🤔» frames while CLI is silent');
  expectContract(failures, !messages.some((call) => String(call.payload.text || '').trim() === '✅'), 'do not leave a separate lone success checkmark');
  expectContract(failures, Boolean(response), 'deliver the model answer');
  expectContract(failures, response?.method === 'editMessageText' && response.payload.message_id === initial?.resultMessageId, 'replace the same initial status message with the short final answer, instead of sending a second message');
  expectContract(failures, /<blockquote>⏱ \d+\.\ds[^<]*<\/blockquote>\s*$/.test(response?.payload.text || ''), 'append the compact elapsed-time blockquote to the final response');
  expectContract(failures, response?.payload.parse_mode === 'HTML', 'the footer must render as a Telegram blockquote');
  expectContract(failures, r.activeIntervals === 0, 'stop typing/status intervals when the turn finishes');
  assert.deepEqual(failures, [], `Missing old progress behavior:\n- ${failures.join('\n- ')}`);
});
