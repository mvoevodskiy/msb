/** The [saved quota reader](../adapters/saved-codex-quota.mjs) through an owned fake app-server. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSavedCodexQuotaReader } from '../adapters/saved-codex-quota.mjs';

const now = Date.parse('2026-11-09T12:00:00.000Z');
const window = (minutes, usedPercent, seconds = now / 1000 + 3600) => ({
  windowDurationMins: minutes, usedPercent, resetsAt: seconds,
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-saved-quota-fake-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), native = path.join(root, 'native'), bin = path.join(root, 'bin');
  await Promise.all([home, native, bin].map(dir => fs.mkdir(dir)));
  const auth = path.join(native, 'auth.json'), config = path.join(native, 'config.toml');
  const response = path.join(root, 'response.json'), log = path.join(root, 'read'), release = path.join(root, 'release');
  await fs.writeFile(config, 'model = "gpt-5.4"\n');
  const select = async (id, token = 'fixture-token-' + id) => {
    const idToken = 'header.' + Buffer.from(JSON.stringify({ sub: 'fixture-user-' + id })).toString('base64url') + '.fixture';
    await fs.writeFile(auth, JSON.stringify({ auth_mode: 'chatgpt',
      tokens: { account_id: id, access_token: token, id_token: idToken } }));
  };
  await select('account-a');
  await fs.writeFile(path.join(bin, 'codex'), '#!' + process.execPath + '\n' + [
    'const fs = require("node:fs"), readline = require("node:readline");',
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") { console.log("codex-cli 0.166.0"); process.exit(0); }',
    'if (args[0] !== "app-server" || !args.includes("features.plugins=false") ||',
    '    !args.includes(\'cli_auth_credentials_store="file"\') || process.env.OPENAI_API_KEY) process.exit(3);',
    'const send = data => console.log(JSON.stringify(data));',
    'readline.createInterface({ input: process.stdin }).on("line", line => {',
    ' const data = JSON.parse(line);',
    ' if (data.method === "initialize") { send({id:data.id,result:{}}); return; }',
    ' if (data.method === "initialized") return;',
    ' if (data.method !== "account/rateLimits/read") process.exit(4);',
    ' const fixture = JSON.parse(fs.readFileSync(' + JSON.stringify(response) + ',"utf8"));',
    ' fs.appendFileSync(' + JSON.stringify(log) + ',"read\\n");',
    ' const answer = () => send(fixture.error ? {id:data.id,error:{code:-1,message:"fixture unavailable"}} : {id:data.id,result:fixture.result});',
    ' if (!fixture.hold) { answer(); return; }',
    ' const timer = setInterval(() => { if (fs.existsSync(' + JSON.stringify(release) + ')) { clearInterval(timer); answer(); } }, 5);',
    '});',
  ].join('\n'), { mode: 0o700 });
  const env = { HOME: home, CODEX_HOME: native, PATH: bin + path.delimiter + process.env.PATH, OPENAI_API_KEY: 'fixture-inherited' };
  const reader = createSavedCodexQuotaReader({ env });
  const read = (signal = AbortSignal.timeout(6000)) => reader({ signal, now: () => now });
  const respond = (result, options) => fs.writeFile(response, JSON.stringify({ result, ...options }));
  const reads = async () => (await fs.readFile(log, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).split('\n').filter(Boolean).length;
  return { read, respond, reads, select, release, auth, config };
}

test('explicit ordinary denial stays bound to its principal and only fresh true clears it', async t => {
  const f = await fixture(t);
  await f.respond({ accountId: 'account-a', ordinaryUsageAllowed: false });
  const first = await f.read();
  assert.equal(first.quota.ordinaryDenied, true);
  assert.deepEqual(first.quota.windows, []);
  await f.respond({ accountId: 'account-a', ordinaryUsageAllowed: null,
    rateLimits: { limitId: 'codex', primary: window(300, 10) } });
  assert.equal((await f.read()).quota.ordinaryDenied, true);
  await f.respond(null, { error: true });
  assert.deepEqual((await f.read()).quota, { ordinaryDenied: true });
  await f.select('account-b');
  await f.respond({ accountId: 'account-b', ordinaryUsageAllowed: false });
  assert.equal((await f.read()).quota.ordinaryDenied, true);
  assert.equal(await first.isCurrent(), false);
  await f.select('account-a', 'refreshed-token');
  await f.respond({ accountId: 'account-a', ordinaryUsageAllowed: null });
  assert.equal((await f.read()).quota.ordinaryDenied, true);
  await f.respond({ accountId: 'account-a', ordinaryUsageAllowed: true });
  assert.equal((await f.read()).quota.ordinaryDenied, false);
});

test('only the selected Codex bucket and verified account contribute window or hard-limit data', async t => {
  const f = await fixture(t);
  await f.respond({ accountId: 'account-a', ordinaryUsageAllowed: true,
    rateLimits: { limitId: 'other-model', spendControlReached: true, primary: window(300, 100) },
    rateLimitsByLimitId: {
      'other-model': { limitId: 'other-model', rateLimitReachedType: 'rate_limit_reached' },
      codex: { limitId: 'codex', primary: window(10080, 97), secondary: window(300, 69),
        individualLimit: { remainingPercent: 0 }, credits: { hasCredits: true } },
    } });
  const report = await f.read();
  assert.deepEqual(report.quota.windows, [
    { minutes: 10080, usedPercent: 97, resetAtMs: now + 3_600_000 },
    { minutes: 300, usedPercent: 69, resetAtMs: now + 3_600_000 },
  ]);
  assert.equal(report.quota.spendControlReached, false);
  assert.equal(report.quota.rateLimitReached, false);
  await f.respond({ accountId: 'account-a', rateLimits: { primary: window(300, 90),
    spendControlReached: true, rateLimitReachedType: 'rate_limit_reached' } });
  const legacy = await f.read();
  assert.equal(legacy.quota.windows.length, 1);
  assert.equal(legacy.quota.spendControlReached, true);
  assert.equal(legacy.quota.rateLimitReached, true);
  await f.respond({ accountId: 'different', ordinaryUsageAllowed: false });
  assert.equal((await f.read()).quota, undefined);
  await f.respond({ rateLimits: { limitId: 'different', primary: window(300, 100), spendControlReached: true } });
  assert.deepEqual((await f.read()).quota.windows, []);
});

test('a same-path account replacement discards the in-flight native result', async t => {
  const f = await fixture(t);
  await f.respond({ accountId: 'account-a', ordinaryUsageAllowed: false }, { hold: true });
  const reading = f.read();
  for (let index = 0; index < 300 && await f.reads() === 0; index++) await delay(10);
  assert.equal(await f.reads(), 1);
  await f.select('account-b');
  await fs.writeFile(f.release, '');
  const report = await reading;
  assert.equal(await report.isCurrent(), false);
  assert.equal(report.quota, undefined);
  await f.respond({ accountId: 'account-b', ordinaryUsageAllowed: null });
  assert.equal((await f.read()).quota.ordinaryDenied, false);
});
