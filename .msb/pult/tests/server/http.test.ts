import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { HistoryResponse, SnapshotResponse } from '../../src/shared/types.ts';
import { silentLog } from '../../src/server/log.ts';
import { startService } from '../../src/server/service.ts';
import { totpAt } from '../../src/server/totp.ts';
import { createHmac } from 'node:crypto';
import { config, cookieFrom, fakeTelegram, fixture, http, INGEST_TOKEN, PASSWORD, TG_TOKEN, tmpDir, wait, type Res } from './helpers.ts';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const FORM = 'application/x-www-form-urlencoded';

async function start(t: TestContext, extraEnv: Record<string, string | undefined> = {}) {
  const dir = tmpDir(t);
  const ui = join(dir, 'ui');
  mkdirSync(join(ui, 'js'), { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Пульт</title><script src="/ui/js/app.js"></script>');
  writeFileSync(join(ui, 'js', 'app.js'), 'console.log(1)');
  writeFileSync(join(ui, 'auth.css'), 'body{}');
  writeFileSync(join(ui, 'tg-bridge.js'), '/* test stub */');
  writeFileSync(join(ui, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, 'secret.txt'), 'секрет');
  const tg = fakeTelegram();
  const clock = { t: Date.now() };
  const cfg = config(join(dir, 'data'), extraEnv);
  const svc = await startService(cfg, { log: silentLog, fetchFn: tg.fetchFn, timers: false, uiDir: ui, now: () => clock.t, retryDelaysMs: [1, 1] });
  t.after(() => svc.close());
  const origin = `http://127.0.0.1:${svc.port}`;
  const req = (method: string, path: string, o: { headers?: Record<string, string>; body?: string | Buffer } = {}) => http(svc.port, method, path, o);
  const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
    req('POST', path, { headers: { 'content-type': FORM, origin, 'user-agent': UA, ...headers }, body: new URLSearchParams(form).toString() });
  const ingest = (body: unknown) =>
    req('POST', '/api/ingest', { headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { svc, tg, clock, cfg, origin, req, post, ingest, dir };
}

/** Полный первый вход: пароль → подключение TOTP → cookie сессии. Возвращает cookie и секрет. */
async function enroll(s: Awaited<ReturnType<typeof start>>): Promise<{ sid: string; secret: string }> {
  const login = await s.post('/login', { password: PASSWORD });
  assert.equal(login.status, 302);
  const pre = cookieFrom(login, 'pult_pre')!;
  const page = await s.req('GET', '/enroll', { headers: { cookie: `pult_pre=${pre}` } });
  const secret = /<code class="auth-secret">([A-Z2-7 ]+)<\/code>/.exec(page.body)![1].replace(/ /g, '');
  const done = await s.post('/enroll', { code: totpAt(secret, s.clock.t) }, { cookie: `pult_pre=${pre}` });
  assert.equal(done.status, 302);
  return { sid: cookieFrom(done, 'pult_sid')!, secret };
}

const headersOk = (r: Res) => {
  assert.equal(r.headers['content-security-policy'], "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org; form-action 'self'; base-uri 'none'");
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], undefined);
  assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(r.headers['referrer-policy'], 'same-origin');
};

function signTgInit(botToken: string, fields: Record<string, string>): string {
  const params = new URLSearchParams(fields);
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

test('HTTP: Mini App — вход по initData без пароля; чужой id и браузер без данных — отказ', async t => {
  const s = await start(t);
  await enroll(s);
  const authDate = Math.floor(s.clock.t / 1000);
  const initData = signTgInit(TG_TOKEN, {
    auth_date: String(authDate),
    user: JSON.stringify({ id: 42, first_name: 'Owner', username: 'owner' }),
  });
  const badOrigin = await s.req('POST', '/api/tg-auth', {
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  assert.equal(badOrigin.status, 403);

  const ok = await s.req('POST', '/api/tg-auth', {
    headers: { origin: s.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  assert.equal(ok.status, 204);
  const sid = cookieFrom(ok, 'pult_tg_sid');
  assert.ok(sid);
  assert.equal((await s.req('GET', '/api/snapshot', { headers: { cookie: `pult_tg_sid=${sid}` } })).status, 200);

  const stranger = signTgInit(TG_TOKEN, {
    auth_date: String(authDate),
    user: JSON.stringify({ id: 999, first_name: 'X' }),
  });
  const denied = await s.req('POST', '/api/tg-auth', {
    headers: { origin: s.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ initData: stranger }),
  });
  assert.equal(denied.status, 401);
  assert.match(JSON.parse(denied.body).error, /не чат владельца/);
});

test('HTTP: одноразовая ссылка ?tg= — сгорает и без сессии, и при живой сессии', async t => {
  const s = await start(t);
  await enroll(s);
  const { acceptTgLoginTicket, issueTgLoginTicket } = await import('../../src/server/auth.ts');

  // 1) Первый вход без сессии — пускает, билет сгорает.
  const ticket = issueTgLoginTicket(s.svc.db, s.clock.t, { once: true, ttlMs: 3600_000 });
  const ok = await s.req('GET', `/?tg=${encodeURIComponent(ticket)}`);
  assert.equal(ok.status, 302);
  const sid = cookieFrom(ok, 'pult_sid');
  assert.ok(sid);
  assert.equal(acceptTgLoginTicket(s.svc.db, ticket, s.clock.t), false, 'после входа билета нет');

  // 2) Новый билет + живая сессия: пускает по cookie, билет всё равно сжигается.
  const ticket2 = issueTgLoginTicket(s.svc.db, s.clock.t, { once: true, ttlMs: 3600_000 });
  const withSession = await s.req('GET', `/?tg=${encodeURIComponent(ticket2)}`, {
    headers: { cookie: `pult_sid=${sid}` },
  });
  assert.equal(withSession.status, 302, 'remove the used ticket from the address even with a valid session');
  assert.equal(withSession.headers.location, '/');
  assert.equal(withSession.headers['set-cookie'], undefined, 'keep the existing session');
  assert.equal((await s.req('GET', '/', { headers: { cookie: `pult_sid=${sid}` } })).status, 200);
  assert.equal(acceptTgLoginTicket(s.svc.db, ticket2, s.clock.t), false, 'при живой сессии билет тоже сгорел');

  // 3) Без сессии этот билет уже не пускает.
  const burned = await s.req('GET', `/?tg=${encodeURIComponent(ticket2)}`);
  assert.equal(burned.status, 200);
  assert.match(burned.body, /auth-form/);
});

test('HTTP: полный сценарий входа — пароль, подключение TOTP, сессия, выход, повторный вход с кодом', async t => {
  const s = await start(t);

  const anon = await s.req('GET', '/api/snapshot');
  assert.equal(anon.status, 401);
  assert.deepEqual(JSON.parse(anon.body), { error: 'Нужен вход' });
  headersOk(anon);
  assert.equal(anon.headers['cache-control'], 'no-store');
  const root = await s.req('GET', '/');
  assert.equal(root.status, 200, 'без сессии «/» — форма входа (200), чтобы Mini App не терял #tgWebAppData');
  assert.match(root.body, /auth-form/);

  const form = await s.req('GET', '/login');
  assert.equal(form.status, 200);
  headersOk(form);
  assert.match(form.body, /<link rel="stylesheet" href="\/ui\/auth.css">/);
  assert.match(form.body, /<body class="auth-page"><main class="auth"><h1 class="auth-title">Пульт<\/h1><p class="auth-sub">/);
  assert.match(form.body, /<form class="auth-form" method="post" action="\/login"><label class="auth-label">Пароль<input class="auth-input" type="password" name="password" autocomplete="current-password" required autofocus><\/label>/);
  assert.doesNotMatch(form.body, /name="code"/, 'второй фактор ещё не подключён — поля кода нет');
  assert.match(form.body, /<script src="\/ui\/tg-bridge\.js" defer><\/script>/, 'мост Mini App на входе');
  assert.doesNotMatch(form.body, /<script(?![^>]*src=)/, 'без инлайн-скриптов');

  const wrong = await s.post('/login', { password: 'не тот пароль' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /<p class="auth-error" role="alert">Неверный пароль или код<\/p>/);

  const login = await s.post('/login', { password: PASSWORD });
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, '/enroll');
  const preHeader = String(login.headers['set-cookie']);
  assert.match(preHeader, /^pult_pre=[A-Za-z0-9_-]{43}; Path=\/enroll; Max-Age=600; HttpOnly; SameSite=Lax$/);
  const pre = cookieFrom(login, 'pult_pre')!;
  assert.equal(cookieFrom(login, 'pult_sid'), null, 'полной сессии до второго фактора нет');

  assert.equal((await s.req('GET', '/enroll')).status, 302, 'без пред-сессии — на вход');
  const page = await s.req('GET', '/enroll', { headers: { cookie: `pult_pre=${pre}` } });
  assert.equal(page.status, 200);
  assert.match(page.body, /<div class="auth-qr"><svg [^>]*role="img"/);
  assert.match(page.body, /<p class="auth-hint">/);
  const secret = /<code class="auth-secret">([A-Z2-7 ]+)<\/code>/.exec(page.body)![1].replace(/ /g, '');
  assert.equal(secret.length, 32);
  const again = await s.req('GET', '/enroll', { headers: { cookie: `pult_pre=${pre}` } });
  assert.ok(again.body.includes(secret.slice(0, 4)), 'обновление страницы — тот же секрет');
  assert.equal((await s.req('GET', '/api/snapshot', { headers: { cookie: `pult_sid=${pre}` } })).status, 401, 'пред-сессия не открывает API');

  const badCode = await s.post('/enroll', { code: '000000' === totpAt(secret, s.clock.t) ? '111111' : '000000' }, { cookie: `pult_pre=${pre}` });
  assert.equal(badCode.status, 401);
  assert.match(badCode.body, /auth-error/);

  const done = await s.post('/enroll', { code: totpAt(secret, s.clock.t) }, { cookie: `pult_pre=${pre}` });
  assert.equal(done.status, 302);
  assert.equal(done.headers.location, '/');
  const setCookies = done.headers['set-cookie'] as string[];
  assert.match(setCookies[0], /^pult_sid=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=14400; HttpOnly; SameSite=Lax$/);
  assert.match(setCookies[1], /^pult_pre=; Path=\/enroll; Max-Age=0/);
  const sid = cookieFrom(done, 'pult_sid')!;
  await wait(20);
  assert.equal(s.tg.texts()[0], '🟢 От тебя ничего не нужно\n\nК Пульту подключён второй фактор входа\nУстройство: Chrome · Android, IP 127.0.0.1');

  const snap = await s.req('GET', '/api/snapshot', { headers: { cookie: `pult_sid=${sid}` } });
  assert.equal(snap.status, 200);
  assert.equal(snap.headers['cache-control'], 'no-store');
  const body = JSON.parse(snap.body) as SnapshotResponse;
  assert.equal(body.snapshot, null);
  assert.equal(body.notify.configured, true);
  assert.ok(body.notify.lastSentAt);

  const index = await s.req('GET', '/', { headers: { cookie: `pult_sid=${sid}` } });
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(index.body, /<title>Пульт<\/title>/);
  assert.equal((await s.req('GET', '/login', { headers: { cookie: `pult_sid=${sid}` } })).headers.location, '/', 'уже вошёл — на панель');
  assert.equal((await s.req('GET', '/enroll', { headers: { cookie: `pult_pre=${pre}` } })).status, 302, 'подключить второй раз нельзя');

  const out = await s.req('POST', '/logout', { headers: { origin: s.origin, cookie: `pult_sid=${sid}` } });
  assert.equal(out.status, 302);
  assert.match(String(out.headers['set-cookie']), /^pult_sid=; Path=\/; Max-Age=0/);
  assert.equal((await s.req('GET', '/api/snapshot', { headers: { cookie: `pult_sid=${sid}` } })).status, 401, 'после выхода сессии нет');

  const form2 = await s.req('GET', '/login');
  assert.match(form2.body, /<label class="auth-label">Код из приложения<input class="auth-input" name="code" inputmode="numeric" pattern="\[0-9\]\{6\}"/);
  const noCode = await s.post('/login', { password: PASSWORD });
  assert.equal(noCode.status, 401, 'без кода — нельзя');
  const replay = await s.post('/login', { password: PASSWORD, code: totpAt(secret, s.clock.t) });
  assert.equal(replay.status, 401, 'код, которым подключали, второй раз не принимается');
  const wrongPass = await s.post('/login', { password: 'x' + PASSWORD, code: totpAt(secret, s.clock.t + 30_000) });
  assert.equal(wrongPass.status, 401);
  s.clock.t += 30_000;
  const ok = await s.post('/login', { password: PASSWORD, code: totpAt(secret, s.clock.t) });
  assert.equal(ok.status, 302, 'код следующего шага не «сожжён» попыткой с неверным паролем');
  assert.equal(ok.headers.location, '/');
  const sid2 = cookieFrom(ok, 'pult_sid')!;
  assert.equal((await s.req('GET', '/api/snapshot', { headers: { cookie: `pult_sid=${sid2}` } })).status, 200);
  await wait(20);
  assert.equal(s.tg.texts().at(-1), '🟢 От тебя ничего не нужно\n\nВход в Пульт: Chrome · Android, IP 127.0.0.1');
});

test('HTTP: приём снимка — 401/400/413/204, затем снимок и история в API', async t => {
  const s = await start(t);
  const { sid } = await enroll(s);
  const auth = { cookie: `pult_sid=${sid}` };

  assert.equal((await s.req('POST', '/api/ingest', { body: '{}' })).status, 401);
  const badToken = await s.req('POST', '/api/ingest', { headers: { authorization: 'Bearer ' + 'x'.repeat(40) }, body: '{}' });
  assert.equal(badToken.status, 401);
  assert.equal(badToken.body, 'Неверный токен сборщика');
  const notJson = await s.req('POST', '/api/ingest', { headers: { authorization: `Bearer ${INGEST_TOKEN}` }, body: '{oops' });
  assert.equal(notJson.status, 400);
  assert.match(notJson.body, /^Тело — не JSON/);
  const badSchema = await s.ingest({ ...fixture(), schema: 2 });
  assert.equal(badSchema.status, 400);
  assert.match(badSchema.body, /schema должна быть 1/);
  const noArr = await s.ingest({ ...fixture(), tasks: null });
  assert.equal(noArr.status, 400);
  assert.match(noArr.body, /tasks должен быть массивом/);
  const huge = await s.req('POST', '/api/ingest', { headers: { authorization: `Bearer ${INGEST_TOKEN}` }, body: Buffer.alloc(5 * 1024 * 1024 + 1, 0x20) });
  assert.equal(huge.status, 413, 'больше 5 МБ');
  assert.equal(huge.body, 'Тело больше 5 МБ');
  const chunked = await s.req('POST', '/api/ingest', { headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'transfer-encoding': 'chunked' }, body: Buffer.alloc(6 * 1024 * 1024, 0x20) });
  assert.equal(chunked.status, 413, 'без Content-Length — считаем по ходу чтения');
  assert.equal((await s.req('GET', '/api/ingest')).status, 405);
  assert.equal((await s.req('GET', '/api/snapshot', { headers: auth })).status, 200, 'после 413 сервис жив');

  // collectedAt фикстуры фиксирован (октябрь) — для истории 24ч подставляем «сейчас» теста.
  const snap = { ...fixture(), collectedAt: new Date(s.clock.t).toISOString() };
  const ok = await s.ingest(snap);
  assert.equal(ok.status, 204);
  assert.equal(ok.body, '');
  // Ровно 5 МБ JSON — ещё принимается.
  const padded = JSON.stringify({ ...snap, sourceErrors: [{ source: 'x', message: '' }] });
  const pad = 5 * 1024 * 1024 - Buffer.byteLength(padded);
  const big = await s.req('POST', '/api/ingest', { headers: { authorization: `Bearer ${INGEST_TOKEN}` }, body: padded.replace('"message":""', `"message":"${'y'.repeat(pad)}"`) });
  assert.equal(big.status, 204, 'ровно 5 МБ — можно');
  await s.ingest(snap);

  s.clock.t += 10_000;
  const r = JSON.parse((await s.req('GET', '/api/snapshot', { headers: auth })).body) as SnapshotResponse;
  assert.equal(r.snapshot?.host, 'Сервер ботов');
  assert.equal(r.snapshot?.bots.length, 3);
  assert.equal(r.ageSec, 10);
  assert.equal(r.stale, false);

  const health = await s.req('GET', '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true, snapshotAgeSec: 10 });
  headersOk(health);

  const h = await s.req('GET', '/api/history?range=24h', { headers: auth });
  const hist = JSON.parse(h.body) as HistoryResponse;
  assert.equal(hist.range, '24h');
  assert.equal(hist.points.length, 1);
  assert.equal(hist.points[0].mem, 45);
  assert.equal((await s.req('GET', '/api/history', { headers: auth })).status, 200, 'по умолчанию 24h');
  assert.equal((await s.req('GET', '/api/history?range=1y', { headers: auth })).status, 400);
  assert.equal((await s.req('GET', '/api/history?range=7d')).status, 401);
  assert.equal((await s.req('GET', '/api/nope', { headers: auth })).status, 404);
});

test('HTTP: защита от подбора — 429 после 5 неудач с IP, тревога при >20 неудачах за час со всех IP', async t => {
  const s = await start(t, { PULT_TRUST_PROXY: '1' });
  for (let i = 0; i < 5; i++) assert.equal((await s.post('/login', { password: 'нет' }, { 'x-real-ip': '203.0.113.7' })).status, 401);
  const blocked = await s.post('/login', { password: PASSWORD }, { 'x-real-ip': '203.0.113.7' });
  assert.equal(blocked.status, 429, 'даже верный пароль — после 5 неудач');
  assert.match(blocked.body, /Слишком много попыток, подожди 15 минут/);
  assert.equal(blocked.headers['retry-after'], '900');
  assert.equal((await s.post('/login', { password: PASSWORD }, { 'x-real-ip': '203.0.113.8' })).status, 302, 'другой IP не задет');
  s.clock.t += 15 * 60_000 + 1000;
  assert.equal((await s.post('/login', { password: PASSWORD }, { 'x-real-ip': '203.0.113.7' })).status, 302, 'через 15 минут — снова можно');

  // Подбор со многих адресов: X-Forwarded-For — берём последний (добавленный nginx).
  for (let i = 0; i < 21; i++) await s.post('/login', { password: 'нет' }, { 'x-forwarded-for': `1.1.1.1, 198.51.100.${i}` });
  await wait(30);
  const alerts = s.tg.texts().filter(x => x.includes('подбирает'));
  assert.deepEqual(alerts, ['🔴 Нужно от тебя: проверить — кто-то подбирает пароль к Пульту (21 неудачных попыток за час)']);
  for (let i = 0; i < 5; i++) await s.post('/login', { password: 'нет' }, { 'x-forwarded-for': `198.51.100.${100 + i}` });
  await wait(30);
  assert.equal(s.tg.texts().filter(x => x.includes('подбирает')).length, 1, 'не чаще раза в час');
});

test('HTTP: без PULT_TRUST_PROXY заголовки IP игнорируются', async t => {
  const s = await start(t);
  for (let i = 0; i < 5; i++) await s.post('/login', { password: 'нет' }, { 'x-real-ip': `203.0.113.${i}` });
  assert.equal((await s.post('/login', { password: PASSWORD }, { 'x-real-ip': '203.0.113.99' })).status, 429, 'подмена X-Real-IP не обходит блок');
});

test('HTTP: проверка Origin для POST', async t => {
  const s = await start(t, { PULT_TRUST_PROXY: '1' });
  const raw = (headers: Record<string, string>) =>
    s.req('POST', '/login', { headers: { 'content-type': FORM, ...headers }, body: 'password=x' });
  assert.equal((await raw({})).status, 403, 'ни Origin, ни Referer');
  assert.equal((await raw({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await raw({ origin: 'null' })).status, 403);
  assert.equal((await raw({ referer: 'https://evil.example/login' })).status, 403);
  assert.equal((await raw({ origin: s.origin })).status, 401, 'свой хост — дальше проверка пароля');
  assert.equal((await raw({ origin: 'https://panel.example.test' })).status, 401, 'внешний адрес панели');
  assert.equal((await raw({ referer: `${s.origin}/login` })).status, 401);
  assert.equal((await raw({ origin: 'null', 'sec-fetch-site': 'same-origin' })).status, 401, 'Origin: null со своей страницы');
  assert.equal((await raw({ origin: 'https://other.test', 'x-forwarded-host': 'other.test' })).status, 401, 'хост от nginx');
  assert.equal((await s.req('POST', '/logout', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await s.req('POST', '/enroll', { headers: { origin: 'https://evil.example' } })).status, 403);
  // Ingest не проверяет Origin — у него свой токен.
  assert.equal((await s.req('POST', '/api/ingest', { headers: { origin: 'https://evil.example', authorization: `Bearer ${INGEST_TOKEN}` }, body: JSON.stringify(fixture()) })).status, 204);
});

test('HTTP: статика — только с сессией (кроме auth.css, tg-bridge и favicon), без выхода за каталог, типы и кэш', async t => {
  const s = await start(t);
  const { sid } = await enroll(s);
  const auth = { cookie: `pult_sid=${sid}` };

  assert.equal((await s.req('GET', '/ui/js/app.js')).status, 401);
  const js = await s.req('GET', '/ui/js/app.js', { headers: auth });
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(js.headers['cache-control'], 'no-cache');
  headersOk(js);
  const etag = String(js.headers.etag);
  assert.equal((await s.req('GET', '/ui/js/app.js', { headers: { ...auth, 'if-none-match': etag } })).status, 304);

  const css = await s.req('GET', '/ui/auth.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  const bridge = await s.req('GET', '/ui/tg-bridge.js');
  assert.equal(bridge.status, 200, 'мост Mini App доступен до входа');
  assert.equal(bridge.headers['content-type'], 'text/javascript; charset=utf-8');
  const ico = await s.req('GET', '/favicon.svg');
  assert.equal(ico.status, 200);
  assert.equal(ico.headers['content-type'], 'image/svg+xml');
  const head = await s.req('HEAD', '/ui/auth.css');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');

  for (const p of ['/ui/../secret.txt', '/ui/%2e%2e/secret.txt', '/ui/..%2Fsecret.txt', '/ui/js/..%2F..%2Fsecret.txt', '/ui/%2e%2e%2f%2e%2e%2fdata%2fpult.db', '/ui/.hidden', '/ui/js/%00', '/ui/%E0%A4%A', '/ui/', '/ui/js', '/ui/nope.js']) {
    const r = await s.req('GET', p, { headers: auth });
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /секрет|SQLite/, p);
  }
  assert.equal((await s.req('GET', '/whatever')).status, 302, 'без сессии — на вход');
  assert.equal((await s.req('GET', '/whatever', { headers: auth })).status, 404);
  assert.equal((await s.req('PUT', '/login', { headers: { origin: s.origin } })).status, 405);
});

test('HTTP: нет интерфейса — понятная страница, сервис работает', async t => {
  const s = await start(t);
  const { sid } = await enroll(s);
  const { rmSync } = await import('node:fs');
  rmSync(join(s.dir, 'ui', 'index.html'));
  const r = await s.req('GET', '/', { headers: { cookie: `pult_sid=${sid}` } });
  assert.equal(r.status, 503);
  assert.match(r.body, /Интерфейс панели не найден/);
});

// Telegram Web embeds Pult cross-site: the signed login must survive its redirect.
// https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies/Partitioned_cookies
test('HTTP: secure Mini App session is partitioned; normal login and CSRF stay protected', async t => {
  const s = await start(t, { PULT_COOKIE_SECURE: '1' });
  const initData = signTgInit(TG_TOKEN, {
    auth_date: String(Math.floor(s.clock.t / 1000)),
    user: JSON.stringify({ id: 42, first_name: 'Owner' }),
  });
  const ok = await s.req('POST', '/api/tg-auth', {
    headers: { origin: s.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  assert.equal(ok.status, 204);
  const setCookie = (ok.headers['set-cookie'] as string[])[0];
  assert.match(setCookie, /^pult_tg_sid=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=14400; HttpOnly; SameSite=None; Secure; Partitioned$/);
  const sid = cookieFrom(ok, 'pult_tg_sid')!;
  assert.equal((await s.req('GET', '/api/snapshot', { headers: { cookie: `pult_tg_sid=${sid}` } })).status, 200);
  const ordinary = await enroll(s);
  const headers = { cookie: `pult_tg_sid=${sid}; pult_sid=${ordinary.sid}` };
  assert.equal((await s.req('GET', '/', { headers })).status, 200);
  assert.doesNotMatch((await s.req('GET', '/', { headers })).body, /auth-form/);
  assert.equal((await s.req('GET', '/api/snapshot', { headers })).status, 200);
  assert.equal((await s.req('POST', '/logout', { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await s.req('GET', '/api/snapshot', { headers })).status, 200);
  const out = await s.req('POST', '/logout', { headers: { ...headers, origin: s.origin } });
  assert.equal(out.status, 302);
  assert.ok((out.headers['set-cookie'] as string[]).some(c => c === 'pult_tg_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=None; Secure; Partitioned'));
  assert.equal((await s.req('GET', '/api/snapshot', { headers })).status, 401);
  assert.equal((await s.req('GET', '/api/snapshot', { headers: { cookie: `pult_sid=${ordinary.sid}` } })).status, 401);
  s.clock.t += 30_000;
  const login = await s.post('/login', { password: PASSWORD, code: totpAt(ordinary.secret, s.clock.t) });
  assert.match((login.headers['set-cookie'] as string[])[0], /; HttpOnly; SameSite=Lax; Secure$/);
  assert.doesNotMatch((login.headers['set-cookie'] as string[])[0], /Partitioned/);
});
