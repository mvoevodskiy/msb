import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { audioTimeoutMs, resolveSttConfig, transcribeVoice } from '../src/media/stt.mjs';

const bytes = new Uint8Array([79, 103, 103, 83]);
const result = (transcript) => new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript }] }] } }));

async function fixture(t, extra = {}) {
  const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-stt-test-'));
  t.after(() => fs.rm(fixtureHome, { recursive: true, force: true }));
  const perBot = path.join(fixtureHome, '.msb/bots/default/.env');
  const shared = path.join(fixtureHome, '.msb/.env');
  const temp = path.join(fixtureHome, 'tmp');
  await fs.mkdir(path.dirname(perBot), { recursive: true });
  await fs.mkdir(temp);
  return { fixtureHome, perBot, shared, temp, env: { HOME: fixtureHome, TMPDIR: temp, MSB_BOT_ID: 'default', ...extra } };
}

test('old audio timeout formula and caps', () => {
  for (const size of [undefined, null, 0, -1, NaN, Infinity]) assert.equal(audioTimeoutMs(size), 300_000);
  assert.equal(audioTimeoutMs(1), 60_000);
  assert.equal(audioTimeoutMs(1_048_576), 90_000);
  assert.equal(audioTimeoutMs(2 * 1_048_576), 120_000);
  assert.equal(audioTimeoutMs(8 * 1_048_576), 300_000);
  assert.equal(audioTimeoutMs(100 * 1_048_576), 300_000);
});

test('settings use process, per-bot, then shared precedence without writing secrets', async (t) => {
  const f = await fixture(t);
  const common = '# fixture only\nDEEPGRAM_API_KEY="shared-fixture"\nSTT_LANGUAGE=EN-US\n';
  await fs.writeFile(f.shared, common);
  assert.equal((await resolveSttConfig(f.env)).apiKey, 'shared-fixture');
  assert.equal((await resolveSttConfig(f.env)).language, 'en-us');
  await fs.writeFile(f.perBot, "DEEPGRAM_API_KEY='bot-fixture'\nSTT_LANGUAGE=fr\n");
  assert.equal((await resolveSttConfig(f.env)).apiKey, 'bot-fixture');
  const withProcess = { ...f.env, DEEPGRAM_API_KEY: 'process-fixture', STT_LANGUAGE: ' MULTI ' };
  const before = { ...withProcess };
  const config = await resolveSttConfig(withProcess);
  assert.equal(config.apiKey, 'process-fixture');
  assert.equal(config.language, 'multi');
  assert.deepEqual(withProcess, before);
  assert.equal(await fs.readFile(f.shared, 'utf8'), common);
  assert.equal(await fs.readFile(f.perBot, 'utf8'), "DEEPGRAM_API_KEY='bot-fixture'\nSTT_LANGUAGE=fr\n");
  assert.equal((await resolveSttConfig({ ...f.env, STT_LANGUAGE: 'ru_RU' })).language, 'ru');
});

test('an explicit empty process or per-bot key never falls back to a shared key', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.shared, 'DEEPGRAM_API_KEY=shared-fixture\n');
  await assert.rejects(resolveSttConfig({ ...f.env, DEEPGRAM_API_KEY: '' }), { code: 'STT_NOT_CONFIGURED' });
  await fs.writeFile(f.perBot, 'DEEPGRAM_API_KEY=\n');
  await assert.rejects(resolveSttConfig(f.env), { code: 'STT_NOT_CONFIGURED' });
  let fetched = false;
  await assert.rejects(transcribeVoice(bytes, { env: f.env, fetchImpl: () => { fetched = true; } }), { code: 'STT_NOT_CONFIGURED' });
  assert.equal(fetched, false);
});

test('Deepgram gets original bytes and old voice options, and returns the complete transcript', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.shared, 'DEEPGRAM_API_KEY=fixture-key\n');
  const full = 'Полная транскрипция '.repeat(30);
  const text = await transcribeVoice(bytes, { env: f.env, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.deepgram.com/v1/listen?model=nova-3&language=ru&smart_format=true&punctuate=true');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { Authorization: 'Token fixture-key', 'Content-Type': 'audio/ogg' });
    assert.deepEqual([...options.body], [...bytes]);
    assert.ok(options.signal instanceof AbortSignal);
    return result(full);
  } });
  assert.equal(text, full);
  assert.equal(f.env.DEEPGRAM_API_KEY, undefined);
});

test('HTTP, empty result and timeout errors are useful and redact reflected credentials', async (t) => {
  const f = await fixture(t, { DEEPGRAM_API_KEY: 'fixture-private-key' });
  await assert.rejects(transcribeVoice(bytes, { env: f.env, fetchImpl: async () => new Response('denied fixture-private-key', { status: 403 }) }), (err) => {
    assert.match(err.message, /Deepgram 403: denied \[REDACTED\]/);
    assert.doesNotMatch(err.stack, /fixture-private-key/);
    return true;
  });
  for (const empty of ['', '   ', undefined]) {
    await assert.rejects(transcribeVoice(bytes, { env: f.env, fetchImpl: async () => result(empty) }), /Deepgram: пустой результат/);
  }
  await assert.rejects(transcribeVoice(bytes, { env: f.env, fetchImpl: async () => { throw new DOMException('late', 'TimeoutError'); } }), /Deepgram не ответил за 60 с/);
  await assert.rejects(transcribeVoice(bytes, { env: f.env, fetchImpl: async () => { throw new Error('network fixture-private-key'); } }), /network \[REDACTED\]/);
});

test('caller abort is honored before fetch and while fetch is pending', async (t) => {
  const f = await fixture(t, { DEEPGRAM_API_KEY: 'fixture-key' });
  const already = new AbortController(); already.abort();
  let fetched = false;
  await assert.rejects(transcribeVoice(bytes, { env: f.env, signal: already.signal, fetchImpl: () => { fetched = true; } }), { name: 'AbortError' });
  assert.equal(fetched, false);
  const controller = new AbortController();
  let announce;
  const started = new Promise((resolve) => { announce = resolve; });
  const pending = transcribeVoice(bytes, { env: f.env, signal: controller.signal, fetchImpl: async (_url, options) => {
    announce();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started; controller.abort(); await rejected;
});

test('late fetch and JSON responses cannot return a transcript after cancellation', async (t) => {
  const f = await fixture(t, { DEEPGRAM_API_KEY: 'fixture-key' });
  for (const stage of ['fetch', 'json']) {
    const controller = new AbortController();
    await assert.rejects(transcribeVoice(bytes, { env: f.env, signal: controller.signal, fetchImpl: async () => {
      if (stage === 'fetch') { controller.abort(); return result('too late'); }
      return { ok: true, async json() { controller.abort(); return { results: { channels: [{ alternatives: [{ transcript: 'too late' }] }] } }; } };
    } }), { name: 'AbortError' });
  }
});

test('STT_COMMAND has priority, one OGG argument, no shell, and removes its temporary input', async (t) => {
  const f = await fixture(t, { DEEPGRAM_API_KEY: 'unused-fixture-key' });
  const command = path.join(f.fixtureHome, 'local transcriber.mjs');
  await fs.writeFile(command, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.HOME + '/command.json', JSON.stringify({ args: process.argv.slice(2), bytes: [...fs.readFileSync(process.argv[2])] }));\nconsole.log('  локальная транскрипция  ');\n`, { mode: 0o700 });
  await fs.writeFile(f.shared, `STT_COMMAND=${command}\n`);
  assert.equal((await resolveSttConfig(f.env)).provider, 'command');
  const text = await transcribeVoice(bytes, { env: f.env, fetchImpl: async () => { throw new Error('Deepgram must not run'); } });
  assert.equal(text, 'локальная транскрипция');
  const audit = JSON.parse(await fs.readFile(path.join(f.fixtureHome, 'command.json'), 'utf8'));
  assert.equal(audit.args.length, 1);
  assert.match(audit.args[0], /audio\.ogg$/);
  assert.deepEqual(audit.bytes, [...bytes]);
  await assert.rejects(fs.access(audit.args[0]), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.temp), []);
  assert.equal((await resolveSttConfig({ ...f.env, STT_COMMAND: '' })).provider, 'deepgram');
});

test('command timeout stays compatible, does not expose stderr secrets, and cleans up on failure', async (t) => {
  const f = await fixture(t, { STT_COMMAND: 'fixture-command', DEEPGRAM_API_KEY: 'fixture-private-key' });
  for (const [value, expected] of [[undefined, 1_800_000], ['0', 1_800_000], ['bad', 1_800_000], ['1', 60_000], ['9000000', 7_200_000]]) {
    assert.equal((await resolveSttConfig({ ...f.env, STT_COMMAND_TIMEOUT_MS: value })).commandTimeoutMs, expected);
  }
  const original = cp.execFile;
  t.after(() => { cp.execFile = original; syncBuiltinESMExports(); });
  cp.execFile = (_command, args, options, callback) => {
    assert.equal(options.shell, false);
    assert.equal(args.length, 1);
    assert.equal(options.maxBuffer, 33_554_432);
    queueMicrotask(() => callback(Object.assign(new Error('fixture-private-key'), { killed: true, signal: 'SIGTERM' })));
  };
  syncBuiltinESMExports();
  await assert.rejects(transcribeVoice(bytes, { env: f.env }), /Команда распознавания не ответила за 1800 с/);
  assert.deepEqual(await fs.readdir(f.temp), []);
});

test('aborting a local command removes the temporary OGG and returns AbortError', async (t) => {
  const f = await fixture(t);
  const command = path.join(f.fixtureHome, 'wait.mjs');
  const startedFile = path.join(f.fixtureHome, 'started');
  await fs.writeFile(command, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.HOME + '/started', process.argv[2]);\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = transcribeVoice(bytes, { env: { ...f.env, STT_COMMAND: command }, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  const deadline = Date.now() + 2000;
  while (!(await fs.access(startedFile).then(() => true, () => false))) {
    if (Date.now() > deadline) { controller.abort(); throw new Error('Fixture command did not start'); }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  await rejected;
  assert.deepEqual(await fs.readdir(f.temp), []);
});
