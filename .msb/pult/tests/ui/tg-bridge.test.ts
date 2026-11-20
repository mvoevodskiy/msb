import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseRoute } from '../../src/ui/logic.js';

const script = readFileSync(fileURLToPath(new URL('../../src/ui/tg-bridge.js', import.meta.url)), 'utf8');
async function openPage(authPage: boolean, hash: string, failHistory = false, failLogin = false) {
  const store = new Map([['__pult_tg_init', 'old-fixture']]);
  const calls: {url: string; options?: Record<string, unknown>}[] = [];
  const replacements: string[] = [], redirects: string[] = [];
  const location = { hash, pathname: '/', search: '', replace: (url: string) => redirects.push(url) };
  const status = { textContent: '' };
  const document = {
    body: { classList: { contains: (name: string) => name === 'auth-page' && authPage } },
    documentElement: { dataset: {} }, getElementById: (id: string) => id === 'tg-auth-status' ? status : null,
  };
  const sessionStorage = { setItem: (k: string, v: string) => store.set(k,v),
    getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => store.delete(k) };
  const state = { marker: 'keep' };
  const history = { state, replaceState: (value: unknown, _: unknown, url: string) => { if (failHistory) throw Error('fixture history denied'); assert.equal(value, state); replacements.push(url); location.hash = url.slice(url.indexOf('#')); } };
  const fetch = async (url: string, options: Record<string, unknown>) => { calls.push({url, options}); return failLogin ? { ok: false, json: async () => ({ error: 'fixture rejected' }) } : { ok: true }; };
  runInNewContext(script, { document, location, history, sessionStorage, fetch });
  await new Promise(resolve => setImmediate(resolve));
  return { location, replacements, redirects, calls, store, status };
}
const init = 'query_id=fixture&user=%7B%22id%22%3A42%7D&auth_date=1&signature=synthetic&hash=synthetic';
const telegram = `#tgWebAppData=${encodeURIComponent(init)}&tgWebAppVersion=9.6&tgWebAppPlatform=weba`;

test('already-authenticated Mini App removes Telegram launch fragment and opens overview', async () => {
  const r = await openPage(false, telegram);
  assert.deepEqual(r.replacements, ['/#/']);
  assert.equal(r.location.hash, '#/');
  assert.equal(r.store.has('__pult_tg_init'), false);
  assert.equal(r.calls.length, 0, 'a valid session does not request reauthentication');
});

test('overview still opens when history.replaceState is unavailable', async () => {
  const r = await openPage(false, telegram, true);
  assert.equal(parseRoute(r.location.hash).name, 'overview');
  assert.equal(r.calls.length, 0);
});

test('first Mini App login still posts full signed initData and cleans it after success', async () => {
  const r = await openPage(true, telegram);
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].url, '/api/tg-auth');
  assert.equal(JSON.parse(String(r.calls[0].options?.body)).initData, init);
  assert.deepEqual(r.redirects, ['/']); assert.deepEqual(r.replacements, []);
  assert.equal(r.store.has('__pult_tg_init'), false);
});

test('first Mini App login failure stays on login and does not retain initData', async () => {
  const r = await openPage(true, telegram, false, true);
  assert.equal(r.calls.length, 1);
  assert.equal(r.status.textContent, 'fixture rejected');
  assert.deepEqual(r.redirects, []); assert.equal(r.store.has('__pult_tg_init'), false);
});

test('normal Pult routes and login without Telegram data remain unchanged', async () => {
  for (const hash of ['#/bots', '#/tasks/abc?range=7d', '#/not-real', '']) {
    const r = await openPage(false, hash);
    assert.deepEqual(r.replacements, []); assert.equal(r.location.hash, hash); assert.equal(r.calls.length, 0);
  }
  const login = await openPage(true, '');
  assert.equal(login.replacements.length, 0); assert.equal(login.calls.length, 0);
});
