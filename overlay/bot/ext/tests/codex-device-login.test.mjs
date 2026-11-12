import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startCodexDeviceLogin } from '../auth-wire.mjs';

const run = promisify(execFile);
const sampleUrl = 'https://auth.openai.com/codex/device';
const sampleCode = 'A7QD-XP402';
const header = `Follow these steps to sign in using device code authorization:\n\u001b[94m${sampleUrl}\u001b[0m\n`;
const tail = `Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n\u001b[94m${sampleCode}\u001b[0m\n`;

async function setup(t, source) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-device-login-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'codex'), `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return { home, bin, env: { HOME: home, PATH: bin, MSB_BOT_ID: 'default' } };
}

async function waitFor(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('fake CLI output did not arrive');
}

test('device code parser strips terminal colours and rejects incomplete output', async (t) => {
  const source = `const fs=require('node:fs');\nprocess.stdout.write(${JSON.stringify(header)});\nlet phase=0; const timer=setInterval(() => { if (phase===0 && fs.existsSync(process.env.HOME + '/next')) { phase=1; process.stdout.write('\\x1b[94mA7QD-XP40'); } if (phase===1 && fs.existsSync(process.env.HOME + '/finish')) { clearInterval(timer); process.stdout.write('2\\x1b[0m\\n'); process.exit(1); } }, 20);`;
  const f = await setup(t, source);
  const started = startCodexDeviceLogin(f.env, f.home);
  assert.equal(started.ok, true);
  t.after(() => started.child.kill('SIGTERM'));
  await waitFor(() => started.extract().text.includes('authorization'));
  const partial = started.extract();
  assert.equal(partial.url, sampleUrl);
  assert.equal(partial.code, null, 'the word authorization is not a device code');
  await fs.writeFile(path.join(f.home, 'next'), 'next');
  await waitFor(() => started.extract().text.includes('A7QD-XP40'));
  assert.equal(started.extract().code, null, 'a partially received code must not be shown');
  await fs.writeFile(path.join(f.home, 'finish'), 'finish');
  const completed = await started.promise;
  assert.equal(completed.url, sampleUrl);
  assert.equal(completed.code, sampleCode);
});

test('Telegram receives the delayed pair after a temporary delivery failure', async (t) => {
  const source = `const fs=require('node:fs');\nconst path=require('node:path');\nif (process.argv.includes('--device-auth')) {\n  process.stdout.write(${JSON.stringify(header)});\n  setTimeout(() => process.stdout.write(${JSON.stringify(tail)}), 2600);\n  setTimeout(() => { fs.mkdirSync(path.join(process.env.HOME, '.codex'), {recursive:true}); fs.writeFileSync(path.join(process.env.HOME,'.codex','auth.json'), JSON.stringify({auth_mode:'chatgpt'})); }, 4700);\n  setTimeout(() => process.exit(0), 8000);\n} else if (process.argv.includes('status')) { console.log('Logged in using ChatGPT'); } else process.exit(1);`;
  const f = await setup(t, source);
  const nativeLogin = new URL('../integration/native-login.mjs', import.meta.url).href;
  const script = `const {connectCodexNative}=await import(${JSON.stringify(nativeLogin)});\nconst texts=[]; let guideAttempts=0; const bot={api:{editMessageText:async (_chat,_id,text)=>texts.push(text),sendMessage:async (_chat,text)=>{if (text.includes('Код: <code>') && ++guideAttempts === 1) throw new Error('temporary fixture failure'); texts.push(text);}}};\nconst ok=await connectCodexNative(bot,42,1);\nconsole.log(JSON.stringify({ok,texts,guideAttempts}));`;
  const env = { ...f.env, PATH: `${f.bin}:/usr/bin:/bin`, MSB_RUNTIME_PROFILE: 'msb' };
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    env, timeout: 14_000, maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  const guides = result.texts.filter(text => text.includes('Codex · вход ChatGPT'));
  assert.ok(guides.some(text => text.includes(`Код: <code>${sampleCode}</code>`) && text.includes(sampleUrl)), 'the complete URL and code must reach Telegram');
  assert.ok(guides.every(text => !text.includes('Код: <code>authorization</code>') && !text.includes('[0m')), 'control characters or non-code words must not be shown');
  assert.ok(guides.every(text => !text.includes('Если ссылка не пришла')), 'a received URL should not trigger a misleading manual-login instruction');
  assert.equal(result.ok, true, 'the simulated native auth still activates Codex');
  assert.equal(result.guideAttempts, 2, 'a failed Telegram delivery must be retried');
});

test('device URL is not published until its last output chunk arrives', async (t) => {
  const source = `const fs=require('node:fs');\nprocess.stdout.write('Visit \\x1b[94mhttps://auth.openai.com/cod');\nconst timer=setInterval(() => { if (fs.existsSync(process.env.HOME + '/next')) { clearInterval(timer); process.stdout.write('ex/device\\x1b[0m\\n${sampleCode}\\n'); process.exit(1); } }, 20);`;
  const f = await setup(t, source);
  const started = startCodexDeviceLogin(f.env, f.home);
  assert.equal(started.ok, true);
  t.after(() => started.child.kill('SIGTERM'));
  await waitFor(() => started.extract().text.includes('https://auth.openai.com/cod'));
  assert.equal(started.extract().url, null, 'an incomplete URL must not be shown');
  await fs.writeFile(path.join(f.home, 'next'), 'next');
  const completed = await started.promise;
  assert.equal(completed.url, sampleUrl);
  assert.equal(completed.code, sampleCode);
});

test('labelled uppercase codes without dashes retain the previous supported format', async (t) => {
  const output = `${sampleUrl}\ncode: ABCDEF\n`;
  const f = await setup(t, `console.log(${JSON.stringify(output)}); process.exit(1);`);
  const started = startCodexDeviceLogin(f.env, f.home);
  assert.equal(started.ok, true);
  const result = await started.promise;
  assert.equal(result.url, sampleUrl);
  assert.equal(result.code, 'ABCDEF');
});


test('URL and code may arrive on separate CLI output streams', async (t) => {
  const source = `process.stdout.write(${JSON.stringify(header)}); process.stderr.write(${JSON.stringify(tail)}); process.exit(1);`;
  const f = await setup(t, source);
  const started = startCodexDeviceLogin(f.env, f.home);
  assert.equal(started.ok, true);
  const result = await started.promise;
  assert.equal(result.url, sampleUrl);
  assert.equal(result.code, sampleCode);
});
