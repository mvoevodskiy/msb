import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decimal, getJson, plural, requireEnv, rub, ToolError, usd } from '../lib.ts';
import { fakeFetch } from './fake-fetch.ts';

test('decimal: два знака, мелочь — четыре, ноль — 0,00', () => {
  assert.equal(decimal(199.91986), '199,92');
  assert.equal(decimal(0.0013), '0,0013');
  assert.equal(decimal(0), '0,00');
  assert.equal(decimal(-0.005), '-0,0050');
  assert.equal(usd(1.5), '$1,50');
  assert.equal(rub(334.75), '334,75 ₽');
});

test('plural: 1, 2–4, 5–20, 11–14, 21, 101, 111', () => {
  const f = ['запрос', 'запроса', 'запросов'] as const;
  const cases: [number, string][] = [
    [0, 'запросов'], [1, 'запрос'], [2, 'запроса'], [4, 'запроса'], [5, 'запросов'], [11, 'запросов'],
    [12, 'запросов'], [14, 'запросов'], [21, 'запрос'], [22, 'запроса'], [101, 'запрос'], [111, 'запросов'],
  ];
  for (const [n, want] of cases) assert.equal(plural(n, f), want, `n=${n}`);
});

test('requireEnv: пусто или пробелы — понятная ошибка с именем переменной', () => {
  assert.equal(requireEnv({ K: ' v ' }, 'K'), 'v');
  for (const env of [{}, { K: '' }, { K: '   ' }]) {
    assert.throws(() => requireEnv(env, 'K'), (e: Error) => e instanceof ToolError && e.message.includes('K') && e.message.includes('/settings'));
  }
});

test('getJson: HTTP-ошибка — ToolError с кодом и началом тела', async () => {
  const { fetch } = fakeFetch(() => ({ status: 403, body: { err: 'forbidden' } }));
  await assert.rejects(getJson('https://x.test/a', {}, { env: {}, fetch }), (e: Error) => e instanceof ToolError && /HTTP 403/.test(e.message) && /forbidden/.test(e.message));
});

test('getJson: не JSON — ToolError', async () => {
  const { fetch } = fakeFetch(() => ({ body: 'oops <html>' }));
  await assert.rejects(getJson('https://x.test/a', {}, { env: {}, fetch }), (e: Error) => e instanceof ToolError && /не JSON/.test(e.message));
});

test('getJson: тайм-аут и обрыв сети — ToolError по-русски', async () => {
  const timeout = (async () => {
    throw Object.assign(new Error('t'), { name: 'TimeoutError' });
  }) as unknown as typeof fetch;
  await assert.rejects(getJson('https://x.test/a', {}, { env: {}, fetch: timeout, timeoutMs: 5000 }), (e: Error) => e instanceof ToolError && /нет ответа за 5 с/.test(e.message));
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  await assert.rejects(getJson('https://x.test/a', {}, { env: {}, fetch: down }), (e: Error) => e instanceof ToolError && /сеть недоступна/.test(e.message));
});
