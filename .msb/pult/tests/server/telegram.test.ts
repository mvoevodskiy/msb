import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { kvGet, openDb } from '../../src/server/db.ts';
import { createTelegram, explainTelegramError, webAppOpenButton } from '../../src/server/telegram.ts';
import { config, fakeTelegram, TG_TOKEN, tmpDir } from './helpers.ts';

/** Локальный «Telegram»: отвечает по очереди заранее заданными ответами. */
async function fakeTgServer(t: TestContext, replies: { status: number; body: unknown }[]) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    seen.push({ url: req.url ?? '', body: JSON.parse(raw || '{}') });
    const r = replies.shift() ?? { status: 200, body: { ok: true, result: {} } };
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

test('Telegram: отправка через PULT_TG_API_BASE — HTML, без превью, журнал и время отправки', async t => {
  const dir = tmpDir(t);
  const srv = await fakeTgServer(t, [{ status: 200, body: { ok: true, result: { message_id: 1 } } }]);
  const cfg = config(dir, { PULT_TG_API_BASE: srv.base });
  const db = openDb(dir);
  t.after(() => db.close());
  const tg = createTelegram({ tg: cfg.tg, db, log: () => {}, now: () => Date.UTC(2026, 9, 30, 5, 0) });
  const r = await tg.send('<b>привет</b>', 'test');
  assert.deepEqual(r, { ok: true, skipped: false, error: null });
  assert.equal(srv.seen[0].url, `/bot${TG_TOKEN}/sendMessage`);
  assert.deepEqual(srv.seen[0].body, { chat_id: '42', text: '<b>привет</b>', parse_mode: 'HTML', disable_web_page_preview: true });
  assert.deepEqual(tg.status(), { configured: true, lastError: null, lastSentAt: '2026-10-30T05:00:00.000Z' });
  const log = db.prepare('SELECT kind, ok, chars FROM tg_log').all();
  assert.deepEqual(log.map(x => ({ ...x })), [{ kind: 'test', ok: 1, chars: 13 }]);
});

test('Telegram: https-панель — кнопка Mini App в сообщении и setChatMenuButton', async t => {
  const dir = tmpDir(t);
  const srv = await fakeTgServer(t, [
    { status: 200, body: { ok: true, result: true } }, // default commands
    { status: 200, body: { ok: true, result: true } }, // owner web_app
    { status: 200, body: { ok: true, result: { message_id: 2 } } },
    { status: 200, body: { ok: true, result: true } }, // send → refreshMenu
  ]);
  const cfg = config(dir, { PULT_TG_API_BASE: srv.base });
  const db = openDb(dir);
  t.after(() => db.close());
  const url = 'https://panel.example.test';
  const tg = createTelegram({ tg: cfg.tg, db, log: () => {}, webAppUrl: url, now: () => Date.UTC(2026, 9, 30, 5, 0) });
  assert.deepEqual(webAppOpenButton(url), { text: 'Пульт сразу', web_app: { url } });
  assert.deepEqual(webAppOpenButton(url, 'ticket1'), { text: 'Пульт сразу', web_app: { url: `${url}/?tg=ticket1` } });
  assert.equal(webAppOpenButton('http://127.0.0.1:8791'), null);
  assert.equal((await tg.setWebAppMenu(url)).ok, true);
  assert.equal(srv.seen[0].url, `/bot${TG_TOKEN}/setChatMenuButton`);
  assert.deepEqual(srv.seen[0].body, { menu_button: { type: 'commands' } }, 'чужим — без Mini App');
  assert.equal(srv.seen[1].body.chat_id, '42');
  const menuUrl = (srv.seen[1].body as { menu_button: { web_app: { url: string } } }).menu_button.web_app.url;
  assert.equal(menuUrl, 'https://panel.example.test', 'меню без ?tg= — вход через initData');
  assert.equal((await tg.send('сводка', 'summary')).ok, true);
  const sendCall = srv.seen.find(c => c.url.endsWith('/sendMessage'));
  assert.ok(sendCall);
  const btnUrl = (sendCall!.body as { reply_markup: { inline_keyboard: { web_app: { url: string } }[][] } }).reply_markup.inline_keyboard[0][0].web_app.url;
  assert.equal(btnUrl, 'https://panel.example.test');
  await new Promise(r => setTimeout(r, 40));
  const menuAfter = srv.seen.filter(c => c.url.endsWith('/setChatMenuButton') && 'chat_id' in c.body).at(-1);
  assert.ok(menuAfter, 'send обновляет меню владельца');
  assert.equal((menuAfter!.body as { menu_button: { web_app: { url: string } } }).menu_button.web_app.url, btnUrl);
  assert.equal((await tg.setWebAppMenu('http://localhost')).skipped, true);
});

test('Telegram: 5xx и сеть — до 3 попыток; 403 — понятная подсказка без повторов; токен нигде не светится', async t => {
  const dir = tmpDir(t);
  const srv = await fakeTgServer(t, [
    { status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } },
    { status: 500, body: { ok: false, error_code: 500, description: 'Internal' } },
    { status: 200, body: { ok: true, result: {} } },
  ]);
  const db = openDb(dir);
  t.after(() => db.close());
  const logs: string[] = [];
  const tg = createTelegram({ tg: config(dir, { PULT_TG_API_BASE: srv.base }).tg, db, log: l => logs.push(l), retryDelaysMs: [10, 10] });
  assert.equal((await tg.send('x', 'alert')).ok, true);
  assert.equal(srv.seen.length, 3);

  const srv2 = await fakeTgServer(t, [{ status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" } }]);
  const tg2 = createTelegram({ tg: config(dir, { PULT_TG_API_BASE: srv2.base }).tg, db, log: l => logs.push(l), retryDelaysMs: [10, 10] });
  const r2 = await tg2.send('x', 'alert');
  assert.deepEqual(r2, { ok: false, skipped: false, error: 'Открой бота уведомлений и нажми «Старт»' });
  assert.equal(srv2.seen.length, 1, '403 не повторяем');
  assert.equal(tg2.status().lastError, 'Открой бота уведомлений и нажми «Старт»');

  // Сеть: порт, где никто не слушает. Ошибка fetch не должна протащить URL с токеном.
  const tg3 = createTelegram({ tg: config(dir, { PULT_TG_API_BASE: 'http://127.0.0.1:1' }).tg, db, log: l => logs.push(l), retryDelaysMs: [5, 5] });
  const r3 = await tg3.send('x', 'alert');
  assert.equal(r3.ok, false);
  assert.match(r3.error ?? '', /^Telegram недоступен/);
  const all = [...logs, r3.error, kvGet(db, 'notify_last_error'), JSON.stringify(db.prepare('SELECT * FROM tg_log').all())].join('\n');
  assert.ok(!all.includes(TG_TOKEN) && !all.includes(TG_TOKEN.split(':')[1]), 'токена нет ни в журнале, ни в ошибках');
});

test('Telegram: успех после ошибки очищает lastError; не настроен — ничего не шлёт', async t => {
  const dir = tmpDir(t);
  const db = openDb(dir);
  t.after(() => db.close());
  let fail = true;
  const fake = fakeTelegram(() => (fail ? { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } } : { status: 200, body: { ok: true, result: {} } }));
  const tg = createTelegram({ tg: config(dir).tg, db, log: () => {}, fetchFn: fake.fetchFn, retryDelaysMs: [1, 1] });
  assert.match((await tg.send('x', 'a')).error ?? '', /чат не найден/);
  assert.equal(fake.calls.length, 1, '400 не повторяем');
  fail = false;
  assert.equal((await tg.send('x', 'a')).ok, true);
  assert.equal(tg.status().lastError, null);

  const off = createTelegram({ tg: config(dir, { PULT_TG_TOKEN: undefined }).tg, db, log: () => {} });
  assert.equal(off.configured, false);
  assert.deepEqual(await off.send('x', 'a'), { ok: false, skipped: true, error: null });
  assert.equal((await off.getMe()).ok, false);
});

test('Telegram: разбор ошибок', () => {
  assert.match(explainTelegramError(401, 'Unauthorized').text, /неверный токен/);
  assert.equal(explainTelegramError(403, 'Forbidden: bot was blocked by the user').text, 'Открой бота уведомлений и нажми «Старт»');
  assert.match(explainTelegramError(400, "Bad Request: can't parse entities: unclosed tag").text, /разметку/);
  assert.equal(explainTelegramError(429, 'Too Many Requests').retry, true);
  assert.equal(explainTelegramError(503, 'x').retry, true);
  assert.equal(explainTelegramError(400, 'x').retry, false);
});
