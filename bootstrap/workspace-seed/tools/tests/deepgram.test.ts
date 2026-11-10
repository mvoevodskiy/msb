import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRange, defaultRange, MAX_PAGES, PAGE_LIMIT, run, usage } from '../deepgram.ts';
import { ToolError, UsageError } from '../lib.ts';
import { fakeFetch, type Route } from './fake-fetch.ts';

const P = 'proj-1';
const env = { DEEPGRAM_API_KEY: 'secret-key' };
const KEYS = {
  api_keys: [
    { api_key: { api_key_id: 'k-demo', comment: 'DemoApp', scopes: ['usage:write'], created: '2026-10-25T10:52:55Z' } },
    { api_key: { api_key_id: 'k-orch', comment: 'Orch', scopes: ['usage:write'], created: '2026-09-20T06:38:04Z' } },
  ],
};

function req(created: string, key: string, usdValue: number, duration: number) {
  return { created, api_key_id: key, response: { details: { usd: usdValue, duration } } };
}

/** Проект P, ключи KEYS, журнал запросов `requests` с настоящей разбивкой на страницы. */
function deepgram(requests: ReturnType<typeof req>[], extra?: Route): Route {
  return (url) => {
    const hit = extra?.(url);
    if (hit) return hit;
    if (url.pathname === '/v1/projects') return { body: { projects: [{ project_id: P, name: 'p' }] } };
    if (url.pathname === `/v1/projects/${P}/balances`) return { body: { balances: [{ balance_id: 'b', amount: 199.91986, units: 'usd' }] } };
    if (url.pathname === `/v1/projects/${P}/keys`) return { body: KEYS };
    if (url.pathname === `/v1/projects/${P}/requests`) {
      const limit = Number(url.searchParams.get('limit'));
      const page = Number(url.searchParams.get('page'));
      return { body: { page, limit, requests: requests.slice(page * limit, (page + 1) * limit) } };
    }
    return undefined;
  };
}

test('balance — по умолчанию; ключ уходит заголовком Token, в вывод не попадает', async () => {
  const { fetch, calls } = fakeFetch(deepgram([]));
  const out = await run([], { env, fetch });
  assert.equal(out, 'Deepgram, остаток: $199,92');
  assert.ok(calls.every((c) => c.headers.Authorization === 'Token secret-key'));
  assert.ok(!out.includes('secret-key'));
  assert.deepEqual(JSON.parse(await run(['balance', '--json'], { env, fetch })), { balances: [{ amount: 199.91986, units: 'usd' }] });
});

test('DEEPGRAM_PROJECT_ID: список проектов не запрашивается', async () => {
  const { fetch, calls } = fakeFetch(deepgram([]));
  await run(['balance'], { env: { ...env, DEEPGRAM_PROJECT_ID: P }, fetch });
  assert.ok(!calls.some((c) => new URL(c.url).pathname === '/v1/projects'));
});

test('несколько проектов без DEEPGRAM_PROJECT_ID — ошибка со списком; ноль проектов — своя ошибка', async () => {
  const two = fakeFetch((url) => (url.pathname === '/v1/projects' ? { body: { projects: [{ project_id: 'a', name: 'A' }, { project_id: 'b', name: 'B' }] } } : undefined));
  await assert.rejects(run(['balance'], { env, fetch: two.fetch }), (e: Error) => e instanceof ToolError && /DEEPGRAM_PROJECT_ID/.test(e.message) && /«B»/.test(e.message));
  const none = fakeFetch((url) => (url.pathname === '/v1/projects' ? { body: { projects: [] } } : undefined));
  await assert.rejects(run(['balance'], { env, fetch: none.fetch }), /ни одного проекта/);
});

test('нет ключа — ошибка до сетевых запросов', async () => {
  const { fetch, calls } = fakeFetch(deepgram([]));
  await assert.rejects(run(['balance'], { env: {}, fetch }), (e: Error) => e instanceof ToolError && /DEEPGRAM_API_KEY/.test(e.message));
  assert.equal(calls.length, 0);
});

test('ключ без прав admin (403) — ToolError, не падение', async () => {
  const { fetch } = fakeFetch(deepgram([], (url) => (url.pathname.endsWith('/balances') ? { status: 403, body: { err_msg: 'Insufficient permissions' } } : undefined)));
  await assert.rejects(run(['balance'], { env, fetch }), (e: Error) => e instanceof ToolError && /403/.test(e.message));
});

test('keys: имя, права, дата', async () => {
  const { fetch } = fakeFetch(deepgram([]));
  assert.equal(await run(['keys'], { env, fetch }), 'Deepgram, ключи:\n  DemoApp: usage:write, создан 2026-10-25\n  Orch: usage:write, создан 2026-09-20');
});

test('usage: сумма по ключам, удалённый ключ, сортировка по деньгам, итог', async () => {
  const { fetch } = fakeFetch(
    deepgram([
      req('2026-10-25T10:55:27Z', 'k-demo', 0.0013, 17.566),
      req('2026-10-22T14:54:52Z', 'k-orch', 0.01, 60),
      req('2026-10-22T14:46:14Z', 'k-orch', 0.02, 120),
      req('2026-10-21T08:00:00Z', 'k-gone-1234567', 0.0005, 3),
    ]),
  );
  const out = await run(['usage', '--from', '2026-10-01', '--to', '2026-10-25'], { env, fetch });
  assert.equal(
    out,
    [
      'Deepgram, расход 01.10.2026–25.10.2026 (UTC):',
      '  Orch: 2 запроса, 3,0 мин, $0,03',
      '  DemoApp: 1 запрос, 0,3 мин, $0,0013',
      '  удалённый ключ k-gone-1: 1 запрос, 0,1 мин, $0,0005',
      '  Итого: 4 запроса, 3,3 мин, $0,03',
    ].join('\n'),
  );
});

test('usage: конец периода включительно — end уходит следующим днём; лишнее за границей отбрасывается', async () => {
  const { fetch, calls } = fakeFetch(
    deepgram([req('2026-10-26T00:00:01Z', 'k-demo', 1, 1), req('2026-10-25T23:59:59Z', 'k-demo', 0.5, 1), req('2026-09-30T23:59:59Z', 'k-demo', 2, 1)]),
  );
  const u = JSON.parse(await run(['usage', '--from', '2026-10-01', '--to', '2026-10-25', '--json'], { env, fetch }));
  assert.equal(u.total.requests, 1);
  assert.equal(u.total.usd, 0.5);
  const q = new URL(calls.find((c) => c.url.includes('/requests'))!.url).searchParams;
  assert.equal(q.get('start'), '2026-10-01');
  assert.equal(q.get('end'), '2026-10-26');
  assert.equal(q.get('limit'), String(PAGE_LIMIT));
});

test('usage: листает страницы, пока страница полная; переход через конец месяца в end', async () => {
  const many = Array.from({ length: PAGE_LIMIT * 2 + 7 }, (_, i) => req('2026-10-31T12:00:00Z', 'k-demo', 0.001, 6));
  const { fetch, calls } = fakeFetch(deepgram(many));
  const u = await usage({ env, fetch }, '2026-10-31', '2026-10-31');
  assert.equal(u.total.requests, PAGE_LIMIT * 2 + 7);
  const pages = calls.filter((c) => c.url.includes('/requests')).map((c) => new URL(c.url).searchParams);
  assert.deepEqual(pages.map((p) => p.get('page')), ['0', '1', '2']);
  assert.equal(pages[0]!.get('end'), '2026-11-01');
});

test('usage: ровно полная последняя страница — ещё один запрос, пустой, и стоп', async () => {
  const { fetch, calls } = fakeFetch(deepgram(Array.from({ length: PAGE_LIMIT }, () => req('2026-10-10T00:00:00Z', 'k-demo', 0, 0))));
  await usage({ env, fetch }, '2026-10-01', '2026-10-31');
  assert.equal(calls.filter((c) => c.url.includes('/requests')).length, 2);
});

test('usage: бесконечная выдача — останавливается на MAX_PAGES с понятной ошибкой', async () => {
  const full = { requests: Array.from({ length: PAGE_LIMIT }, () => req('2026-10-10T00:00:00Z', 'k-demo', 0, 0)) };
  const { fetch, calls } = fakeFetch(deepgram([], (url) => (url.pathname.endsWith('/requests') ? { body: full } : undefined)));
  await assert.rejects(usage({ env, fetch }, '2026-10-01', '2026-10-31'), (e: Error) => e instanceof ToolError && /сузь/.test(e.message));
  assert.equal(calls.filter((c) => c.url.includes('/requests')).length, MAX_PAGES);
});

test('usage: пустой период', async () => {
  const { fetch } = fakeFetch(deepgram([]));
  assert.equal(await run(['usage', '--from', '2026-10-01', '--to', '2026-10-02'], { env, fetch }), 'Deepgram, расход 01.10.2026–02.10.2026 (UTC):\n  запросов не было');
});

test('usage по умолчанию: с 1-го числа текущего месяца по сегодня (UTC)', async () => {
  assert.deepEqual(defaultRange(new Date('2026-10-25T23:30:00Z')), { from: '2026-10-01', to: '2026-10-25' });
  const { fetch, calls } = fakeFetch(deepgram([]));
  await run(['usage'], { env, fetch, now: new Date('2026-02-28T10:00:00Z') });
  const q = new URL(calls.find((c) => c.url.includes('/requests'))!.url).searchParams;
  assert.equal(q.get('start'), '2026-02-01');
  assert.equal(q.get('end'), '2026-03-01');
});

test('неверный вызов — UsageError без сетевых запросов', async () => {
  const { fetch, calls } = fakeFetch(deepgram([]));
  const bad = [
    ['usage', '--from', '2026-10-32'],
    ['usage', '--from', '25.10.2026'],
    ['usage', '--from', '2026-10-25', '--to', '2026-10-01'],
    ['balance', '--from', '2026-10-01'],
    ['nope'],
    ['keys', 'extra'],
    ['--bogus'],
    ['usage', '--from'],
  ];
  for (const argv of bad) await assert.rejects(run(argv, { env, fetch }), UsageError, argv.join(' '));
  assert.equal(calls.length, 0);
  assert.throws(() => checkRange('2026-02-30', '2026-03-01'), UsageError);
});

test('--help — без сети и без ключа', async () => {
  const out = await run(['--help'], { env: {} });
  assert.match(out, /balance/);
  assert.match(out, /usage/);
  assert.match(out, /Бесплатно/);
});
