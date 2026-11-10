import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apifyBalance, DeepgramBalance, parseDeepgram, proxyapiBalance } from '../../src/collector/sources/balances.ts';
import type { ExecResult } from '../../src/collector/util.ts';
import { DEEPGRAM_OUT, FIX, fakeExec } from './helpers.ts';

const now = Date.parse('2026-10-29T10:45:00Z');
const withFile = (data: unknown, fn: (path: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'pult-bal-'));
  try {
    const p = join(dir, 'b.json');
    writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
    fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('ProxyAPI: «334,75 ₽», норма = не low, устарел через 3 ч', () => {
  assert.deepEqual(proxyapiBalance(join(FIX, 'proxyapi-balance.json'), 50, now),
    { id: 'proxyapi', name: 'ProxyAPI', value: '334,75 ₽', ok: true, checkedAt: '2026-10-29T10:26:50.831Z', stale: false, note: null });
  assert.equal(proxyapiBalance(join(FIX, 'proxyapi-balance.json'), 50, now + 4 * 3600_000).stale, true);
  withFile({ checkedAt: '2026-10-29T10:00:00Z', balanceRub: 40 }, p => assert.equal(proxyapiBalance(p, 50, now).ok, false, 'нет флага low — по порогу'));
  withFile({ checkedAt: '2026-10-29T10:00:00Z', balanceRub: 40, low: false }, p => assert.equal(proxyapiBalance(p, 50, now).ok, true, 'флаг файла важнее'));
  withFile({ checkedAt: '2026-10-29T10:00:00Z', ok: false }, p => assert.deepEqual(proxyapiBalance(p, 50, now),
    { id: 'proxyapi', name: 'ProxyAPI', value: 'нет данных', ok: null, checkedAt: '2026-10-29T10:00:00.000Z', stale: false, note: 'последняя проверка не удалась' }));
  assert.deepEqual(proxyapiBalance('/нет/файла.json', 50, now).note, 'нет файла проверки');
  withFile('{oops', p => assert.equal(proxyapiBalance(p, 50, now).note, 'файл повреждён (не JSON)'));
});

test('Apify: «$0,007 из $5», норма — меньше 80 % лимита', () => {
  assert.deepEqual(apifyBalance(join(FIX, 'x-status.json'), now),
    { id: 'apify', name: 'Apify', value: '$0,007 из $5', ok: true, checkedAt: '2026-10-29T10:18:14.036Z', stale: false, note: null });
  withFile({ last_run: '2026-10-29T10:00:00Z', month: { account_usage_usd: 4.2, account_limit_usd: 5 } }, p => {
    const b = apifyBalance(p, now);
    assert.equal(b.value, '$4,20 из $5');
    assert.equal(b.ok, false);
  });
  withFile({ last_run: '2026-10-29T10:00:00Z' }, p => assert.equal(apifyBalance(p, now).value, 'нет данных'));
});

test('Deepgram: разбор ответа инструмента', () => {
  assert.equal(parseDeepgram(DEEPGRAM_OUT), 199.89790582);
  assert.equal(parseDeepgram('{"balances":[{"amount":1,"units":"usd"},{"amount":2,"units":"USD"},{"amount":5,"units":"eur"}]}'), 3);
  assert.throws(() => parseDeepgram('{"balances":[]}'), /нет остатка/);
  assert.throws(() => parseDeepgram('не json'));
});

const cfg = { command: ['deepgram-fake', 'balance', '--json'], everyMin: 60, lowUsd: null };

test('Deepgram: нет ключа — «нет данных», команда не запускается', async () => {
  const exec = fakeExec();
  const b = await new DeepgramBalance(cfg, exec).get(now, {});
  assert.deepEqual(b, { id: 'deepgram', name: 'Deepgram', value: 'нет данных', ok: null, checkedAt: null, stale: false, note: 'нет ключа DEEPGRAM_API_KEY' });
  assert.equal(exec.calls.length, 0);
});

test('Deepgram: не чаще everyMin, ошибка после успеха — прошлый остаток как устаревший', async () => {
  let fail = false;
  const exec = fakeExec({ 'deepgram-fake': (): ExecResult => (fail ? { code: 1, stdout: '', stderr: 'Deepgram: 401', error: 'Deepgram: 401' } : { code: 0, stdout: DEEPGRAM_OUT, stderr: '', error: null }) });
  const dg = new DeepgramBalance(cfg, exec);
  const env = { DEEPGRAM_API_KEY: 'k' };
  const first = await dg.get(now, env);
  assert.equal(first.value, '$199,90');
  assert.equal(first.ok, true);
  assert.equal((await dg.get(now + 30 * 60_000, env)).value, '$199,90');
  assert.equal(exec.calls.length, 1, 'в пределах часа — из памяти');
  fail = true;
  const later = await dg.get(now + 2 * 3600_000, env);
  assert.equal(exec.calls.length, 2);
  assert.equal(later.value, '$199,90');
  assert.equal(later.stale, true);
  assert.equal(later.ok, null);
  assert.equal(later.note, 'Deepgram: 401');
  assert.deepEqual(exec.calls[0].args, ['balance', '--json']);
});

test('Deepgram: долгий ответ не держит тик — дойдёт в следующий снимок', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const exec = fakeExec({ 'deepgram-fake': () => ({ code: 0, stdout: DEEPGRAM_OUT, stderr: '', error: null }) });
  const slow = (async (cmd: string, args: string[]) => {
    await gate;
    return exec(cmd, args);
  }) as typeof exec;
  const dg = new DeepgramBalance(cfg, slow);
  const env = { DEEPGRAM_API_KEY: 'k' };
  const first = await dg.get(now, env, 20);
  assert.equal(first.value, 'нет данных');
  assert.match(first.note ?? '', /следующем снимке/);
  release();
  await new Promise(r => setTimeout(r, 10));
  assert.equal((await dg.get(now + 60_000, env, 20)).value, '$199,90');
});
