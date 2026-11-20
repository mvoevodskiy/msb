import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolError, UsageError } from '../lib.ts';
import { BALANCE_URL, LOW_RUB, run } from '../proxyapi.ts';
import { fakeFetch } from './fake-fetch.ts';

const env = { PROXYAPI_KEY: 'secret-key' };

function balanceIs(body: unknown, status = 200) {
  return fakeFetch((url) => (url.href === BALANCE_URL ? { status, body } : undefined));
}

test('остаток: рубли, ключ — Bearer, в вывод не попадает', async () => {
  const { fetch, calls } = balanceIs({ balance: 334.7512 });
  const out = await run([], { env, fetch });
  assert.equal(out, 'ProxyAPI, остаток: 334,75 ₽');
  assert.equal(calls[0]!.headers.Authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(await run(['--json'], { env, fetch })), { balanceRub: 334.75, low: false });
});

test('ниже порога — напоминание; ровно на пороге — нет', async () => {
  assert.match(await run([], { env, fetch: balanceIs({ balance: LOW_RUB - 0.01 }).fetch }), /мало, пора пополнить/);
  assert.equal(await run([], { env, fetch: balanceIs({ balance: LOW_RUB }).fetch }), 'ProxyAPI, остаток: 50,00 ₽');
});

test('нет balance в ответе или HTTP-ошибка — ToolError', async () => {
  for (const body of [{}, { balance: '12' }, { balance: null }]) {
    await assert.rejects(run([], { env, fetch: balanceIs(body).fetch }), ToolError);
  }
  await assert.rejects(run([], { env, fetch: balanceIs({ detail: 'bad key' }, 401).fetch }), (e: Error) => e instanceof ToolError && /401/.test(e.message));
});

test('нет ключа — ошибка до сети; неверный вызов — UsageError', async () => {
  const { fetch, calls } = balanceIs({ balance: 1 });
  await assert.rejects(run([], { env: {}, fetch }), /PROXYAPI_KEY/);
  for (const argv of [['usage'], ['balance', 'x'], ['--bogus']]) await assert.rejects(run(argv, { env, fetch }), UsageError);
  assert.equal(calls.length, 0);
});
