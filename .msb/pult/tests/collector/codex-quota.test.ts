import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSubscription, CodexQuota, readCodexLimits } from '../../src/collector/sources/codex-quota.ts';
import { readBotData } from '../../src/collector/sources/journal.ts';
import { activeProvider } from '../../src/collector/sources/provider.ts';
import { Problems } from '../../src/collector/util.ts';
import { Collector } from '../../src/collector/collect.ts';
import { fixtureConfig, fakeExec, FIX, NOW } from './helpers.ts';
import { subscriptionInfo } from '../../src/ui/logic.js';
const now = NOW.getTime();
const raw = { rateLimits: { limitId: 'codex', primary: { usedPercent: 69, windowDurationMins: 10080, resetsAt: now / 1000 + 1000 }, secondary: null } };
function dir(t: TestContext) { const d = mkdtempSync(join(tmpdir(), 'quota-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }
test('Codex measured windows: quota is not context or API money; missing/invalid stays unknown', () => {
  const q = codexSubscription(raw, now);
  assert.equal(codexSubscription({ ...raw, ordinaryUsageAllowed: false }, now).status, 'limited');
  assert.equal(codexSubscription({ rateLimits: { ...raw.rateLimits, rateLimitReachedType: 'primary' } }, now).status, 'limited');
  assert.equal(q.providerId, 'codex'); assert.equal(q.status, 'allowed');
  assert.equal(q.windows?.[0].usedPercent, 69);
  assert.match(subscriptionInfo(q, now)!.text, /7 дн.: осталось 31%/);
  const two = codexSubscription({ rateLimits: { ...raw.rateLimits, secondary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now / 1000 + 2000 } } }, now);
  const mixed = codexSubscription({ rateLimits: { ...raw.rateLimits, primary: { ...raw.rateLimits.primary, usedPercent: 100, resetsAt: now / 1000 - 1 }, secondary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now / 1000 + 2000 } } }, now);
  assert.equal(mixed.resetsAt, new Date(now + 2000000).toISOString());
  assert.equal(two.status, 'limited'); assert.equal(two.windows?.length, 2);
  for (const v of [{}, { rateLimits: { primary: null } }, { rateLimits: { ...raw.rateLimits, limitId: 'other' } }, { rateLimits: { primary: { ...raw.rateLimits.primary, usedPercent: -1 } } }]) assert.throws(() => codexSubscription(v, now));
});
test('Codex cache refresh failure keeps original timestamp, stale flag; recovery clears it', async () => {
  let calls = 0; let fail = false;
  const c = new CodexQuota(async () => { calls++; if (fail) throw Error('private error'); return raw; });
  const first = await c.get(now); await c.get(now + 1); assert.equal(calls, 1);
  fail = true; const stale = await c.get(now + 300000); assert.equal(stale.subscription?.updatedAt, first.subscription?.updatedAt);
  assert.equal(stale.subscription?.stale, true); assert.ok(stale.error); assert.doesNotMatch(stale.error!, /private/);
  fail = false; assert.equal((await c.get(now + 600000)).subscription?.stale, undefined);
});
test('provider routing never lends Claude rateLimitInfo to Codex, Cursor, Qwen, unknown or OpenClaw', t => {
  const d = dir(t); const rate = { status: 'allowed', lastUpdatedAt: now / 1000 };
  writeFileSync(join(d, 'state.json'), JSON.stringify({ rateLimitInfo: rate }));
  assert.equal(activeProvider(d), 'claude'); assert.deepEqual(readBotData(d, now, new Problems(), 'T').rate, rate);
  for (const active of ['codex', 'cursor', 'qwen', 'unknown', 'claude']) {
    writeFileSync(join(d, 'ext-providers.json'), JSON.stringify({ active }));
    assert.equal(activeProvider(d), active);
    assert.deepEqual(readBotData(d, now, new Problems(), 'T').rate, active === 'claude' ? rate : null);
  }
  writeFileSync(join(d, 'state.json'), JSON.stringify({ engine: 'oc', rateLimitInfo: rate }));
  assert.equal(activeProvider(d), 'openclaw'); assert.equal(readBotData(d, now, new Problems(), 'T').rate, null);
});
test('collector keeps Claude and Codex separate and stops requesting Codex after switch', async t => {
  const d = dir(t); for (const [id, active] of [['cc', 'claude'], ['cx', 'codex']]) {
    mkdirSync(join(d, id)); writeFileSync(join(d, id, 'ext-providers.json'), JSON.stringify({ active }));
    writeFileSync(join(d, id, 'state.json'), JSON.stringify({ rateLimitInfo: { status: 'rejected', lastUpdatedAt: now / 1000, resetsAt: now / 1000 + 600 } }));
  }
  let calls = 0; let clock = now;
  const c = new Collector(fixtureConfig({ botsRoot: d, bots: [{ id: 'cc', name: 'CC', unit: 'cc.service', projects: [] }, { id: 'cx', name: 'CX', unit: 'cx.service', projects: [] }], timers: [], balances: {} }), {
    exec: fakeExec(), procRoot: join(FIX, 'proc'), cgroupRoot: join(FIX, 'cgroup'), firstCpuSampleMs: 0, clock: () => new Date(clock),
    readCodexQuota: async () => { calls++; return raw; },
  });
  const s = await c.collect(); assert.equal(calls, 1); assert.equal(s.subscription?.status, 'rejected');
  assert.deepEqual(s.subscriptions?.map(q => [q.providerId, q.status]), [['claude', 'rejected'], ['codex', 'allowed']]);
  writeFileSync(join(d, 'cx', 'ext-providers.json'), JSON.stringify({ active: 'qwen' })); clock += 600000;
  const switched = await c.collect(); assert.equal(calls, 1); assert.deepEqual(switched.subscriptions?.map(q => q.providerId), ['claude']);
});
test('stdio only initializes and reads limits; process ends, errors/timeouts are bounded', async t => {
  const d = dir(t), bin = join(d, 'codex');
  writeFileSync(bin, `#!${process.execPath}\n` + `import('node:readline').then(({createInterface}) => { const rl = createInterface({input:process.stdin}); rl.on('line', line => { const x=JSON.parse(line); if(x.method==='initialize') { console.log('null'); console.log('[]'); console.log('broken'); console.log(JSON.stringify({id:1,result:{}})); } else if(x.method==='account/rateLimits/read') console.log(JSON.stringify({id:2,result:${JSON.stringify(raw)}})); else if(x.method!=='initialized') process.exit(7); }); });`, { mode: 0o700 });
  assert.deepEqual(await readCodexLimits(bin, process.env, 3000), raw);
  writeFileSync(bin, `#!${process.execPath}\nsetInterval(()=>{},1000);`, { mode: 0o700 });
  await assert.rejects(readCodexLimits(bin, process.env, 100), /таймаут/);
  await assert.rejects(readCodexLimits(join(d, 'missing'), process.env, 100), /недоступен/);
});
