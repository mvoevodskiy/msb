import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IngestWatch } from '../../src/collector/watch.ts';
import { sendTg, tgFromEnv } from '../../src/shared/tg.ts';

const T0 = Date.parse('2026-10-29T18:00:00Z'); // 21:00 МСК
const MIN = 60_000;

test('сторож: короткий сбой — молча; 10 мин подряд — одна тревога; восстановление — одно сообщение', () => {
  const w = new IngestWatch({ publicUrl: 'https://pult.example' });
  assert.equal(w.update(null, T0), null);
  assert.equal(w.update('нет связи (ECONNREFUSED)', T0 + MIN), null);
  assert.equal(w.update(null, T0 + 2 * MIN), null, 'перезапуск при выкладке — без сообщений');

  assert.equal(w.update('нет связи (ECONNREFUSED)', T0 + 3 * MIN), null);
  assert.equal(w.update('ответ HTTP 502', T0 + 12 * MIN), null, '9 мин — ещё рано');
  const alert = w.update('ответ HTTP 502 <html>', T0 + 13 * MIN);
  assert.equal(alert?.kind, 'alert');
  const lines = alert!.text.split('\n');
  assert.equal(lines[0], '🔴 Нужно от тебя: посмотреть — Пульт не принимает данные');
  assert.match(alert!.text, /с 21:03 сборщик не может передать снимок веб-сервису: ответ HTTP 502 &lt;html&gt;\./);
  assert.equal(lines.at(-1), 'https://pult.example');
  assert.equal(w.update('ответ HTTP 502', T0 + 30 * MIN), null, 'повторно не тревожит');

  const rec = w.update(null, T0 + 40 * MIN);
  assert.equal(rec?.kind, 'recovery');
  assert.equal(rec?.text, '🟢 От тебя ничего не нужно\n\nВеб-сервис Пульта снова принимает данные (не принимал с 21:03 до 21:40).');
  assert.equal(w.update(null, T0 + 41 * MIN), null);
});

test('сторож: тревога не ушла — повтор на следующем тике; без тревоги нет и «снова в норме»', () => {
  const w = new IngestWatch();
  w.update('сбой', T0);
  assert.equal(w.update('сбой', T0 + 10 * MIN)?.kind, 'alert');
  w.retry();
  assert.equal(w.update('сбой', T0 + 11 * MIN)?.kind, 'alert');
  w.retry();
  assert.equal(w.update(null, T0 + 12 * MIN), null);
});

test('настройки Telegram из окружения: нужен токен и чат; чат по умолчанию — владелец', () => {
  assert.equal(tgFromEnv({}), null);
  assert.equal(tgFromEnv({ PULT_TG_TOKEN: '1:a' }), null);
  assert.deepEqual(tgFromEnv({ PULT_TG_TOKEN: '1:a', OWNER_USER_ID: '42' }), { token: '1:a', chatId: '42', apiBase: undefined });
  assert.equal(tgFromEnv({ PULT_TG_TOKEN: '1:a', OWNER_USER_ID: '42', PULT_TG_CHAT_ID: '7' })?.chatId, '7');
});

test('отправка: успех; 403 — без повторов; сбой сети — повторы и причина без токена', async () => {
  const target = { token: '123:SECRET', chatId: '42', apiBase: 'http://tg' };
  const calls: string[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.deepEqual(JSON.parse(String(init.body)), { chat_id: '42', text: 'привет', parse_mode: 'HTML', disable_web_page_preview: true });
    return new Response('{"ok":true}');
  }) as unknown as typeof fetch;
  assert.equal(await sendTg(target, 'привет', { fetchFn: ok, delaysMs: [] }), null);
  assert.equal(calls[0], 'http://tg/bot123:SECRET/sendMessage');

  let n = 0;
  const forbidden = (async () => { n++; return new Response('{"ok":false,"description":"Forbidden: bot was blocked by the user 123:SECRET"}', { status: 403 }); }) as unknown as typeof fetch;
  const err = await sendTg(target, 'x', { fetchFn: forbidden, delaysMs: [1, 1] });
  assert.equal(n, 1);
  assert.equal(err, 'Telegram ответил 403: Forbidden: bot was blocked by the user ***');

  n = 0;
  const down = (async () => { n++; throw new TypeError('fetch failed http://tg/bot123:SECRET/sendMessage'); }) as unknown as typeof fetch;
  const err2 = await sendTg(target, 'x', { fetchFn: down, delaysMs: [1, 1] });
  assert.equal(n, 3);
  assert.equal(err2, 'нет связи с Telegram (TypeError)');
});
