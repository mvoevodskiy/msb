import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../../src/server/config.ts';
import { env, INGEST_TOKEN, PASSWORD, TG_TOKEN } from './helpers.ts';

const base = (extra: Record<string, string | undefined> = {}) => env('/tmp/pult-cfg', { PULT_PORT: undefined, PULT_COOKIE_SECURE: undefined, ...extra });

test('настройки: значения по умолчанию', () => {
  const c = loadConfig(base({ PULT_TG_TOKEN: undefined, PULT_TG_CHAT_ID: undefined }));
  assert.equal(c.port, 8791);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.cookieSecure, true);
  assert.equal(c.trustProxy, false);
  assert.equal(c.staleSec, 300);
  assert.equal(c.summaryHour, 8);
  assert.equal(c.tz, 'Europe/Moscow');
  assert.equal(c.sessionTtlMs, 4 * 60 * 60 * 1000, 'сессия по умолчанию 4 часа');
  assert.equal(c.tg, null, 'без токена Telegram не настроен, но сервис стартует');
  assert.equal(c.publicUrl, 'https://panel.example.test');
});

test('настройки: PULT_SESSION_HOURS', () => {
  const c = loadConfig(base({ PULT_SESSION_HOURS: '12', PULT_TG_TOKEN: undefined, PULT_TG_CHAT_ID: undefined }));
  assert.equal(c.sessionTtlMs, 12 * 60 * 60 * 1000);
  assert.throws(() => loadConfig(base({ PULT_SESSION_HOURS: '0' })), /PULT_SESSION_HOURS/);
  assert.throws(() => loadConfig(base({ PULT_SESSION_HOURS: '999' })), /PULT_SESSION_HOURS/);
});

test('настройки: обязательные поля — понятная ошибка', () => {
  for (const name of ['PULT_DATA_DIR', 'PULT_PASSWORD', 'PULT_INGEST_TOKEN', 'PULT_PUBLIC_URL']) {
    assert.throws(() => loadConfig(base({ [name]: undefined })), (e: Error) => e instanceof ConfigError && e.message.startsWith(`${name} не задан`), name);
    assert.throws(() => loadConfig(base({ [name]: '   ' })), ConfigError, `${name} из пробелов`);
  }
});

test('настройки: длина пароля и токена, секреты не попадают в текст ошибки', () => {
  const shortPass = 'short-pass1';
  assert.throws(() => loadConfig(base({ PULT_PASSWORD: shortPass })), (e: Error) => /12 символов/.test(e.message) && !e.message.includes(shortPass));
  assert.doesNotThrow(() => loadConfig(base({ PULT_PASSWORD: 'двенадцать!!' })), 'кириллица считается по символам');
  const shortToken = 'x'.repeat(31);
  assert.throws(() => loadConfig(base({ PULT_INGEST_TOKEN: shortToken })), (e: Error) => /32 символов/.test(e.message) && !e.message.includes(shortToken));
  assert.throws(() => loadConfig(base({ PULT_TG_TOKEN: 'not-a-token-secret' })), (e: Error) => /PULT_TG_TOKEN/.test(e.message) && !e.message.includes('not-a-token-secret'));
});

test('настройки: числа, флаги, адреса, часовой пояс', () => {
  assert.throws(() => loadConfig(base({ PULT_PORT: '70000' })), /PULT_PORT/);
  assert.throws(() => loadConfig(base({ PULT_PORT: 'abc' })), /PULT_PORT/);
  assert.throws(() => loadConfig(base({ PULT_COOKIE_SECURE: 'yes' })), /PULT_COOKIE_SECURE: ожидается 1 или 0/);
  assert.throws(() => loadConfig(base({ PULT_SUMMARY_HOUR: '24' })), /PULT_SUMMARY_HOUR/);
  assert.throws(() => loadConfig(base({ PULT_STALE_SEC: '5' })), /PULT_STALE_SEC/);
  assert.throws(() => loadConfig(base({ PULT_TZ: 'Mars/Olympus' })), /PULT_TZ/);
  assert.throws(() => loadConfig(base({ PULT_PUBLIC_URL: 'panel.mp.aaa0.ru' })), /PULT_PUBLIC_URL/);
  assert.throws(() => loadConfig(base({ PULT_PUBLIC_URL: 'ftp://x' })), /PULT_PUBLIC_URL/);
  assert.throws(() => loadConfig(base({ PULT_DATA_DIR: 'data' })), /абсолютный/);
  const c = loadConfig(base({ PULT_PORT: '9000', PULT_HOST: '0.0.0.0', PULT_COOKIE_SECURE: '0', PULT_TRUST_PROXY: '1', PULT_STALE_SEC: '600', PULT_SUMMARY_HOUR: '9', PULT_TZ: 'America/Bogota', PULT_PUBLIC_URL: 'https://panel.mp.aaa0.ru/' }));
  assert.deepEqual([c.port, c.host, c.cookieSecure, c.trustProxy, c.staleSec, c.summaryHour, c.tz, c.publicUrl], [9000, '0.0.0.0', false, true, 600, 9, 'America/Bogota', 'https://panel.mp.aaa0.ru']);
});

test('настройки: Telegram — оба поля, чат по умолчанию из OWNER_USER_ID, адрес API для тестов', () => {
  assert.throws(() => loadConfig(base({ PULT_TG_CHAT_ID: undefined })), /PULT_TG_CHAT_ID/);
  const owner = loadConfig(base({ PULT_TG_CHAT_ID: undefined, OWNER_USER_ID: '777' }));
  assert.equal(owner.tg?.chatId, '777');
  const explicit = loadConfig(base({ PULT_TG_CHAT_ID: '-100123', OWNER_USER_ID: '777' }));
  assert.equal(explicit.tg?.chatId, '-100123');
  assert.equal(explicit.tg?.apiBase, 'https://api.telegram.org');
  assert.equal(explicit.tg?.token, TG_TOKEN);
  assert.throws(() => loadConfig(base({ PULT_TG_CHAT_ID: 'чат' })), /PULT_TG_CHAT_ID/);
  const fake = loadConfig(base({ PULT_TG_API_BASE: 'http://127.0.0.1:9999/' }));
  assert.equal(fake.tg?.apiBase, 'http://127.0.0.1:9999');
  const noToken = loadConfig(base({ PULT_TG_TOKEN: undefined, OWNER_USER_ID: '777' }));
  assert.equal(noToken.tg, null, 'чат без токена — Telegram не настроен');
  assert.equal(loadConfig(base()).password, PASSWORD);
  assert.equal(loadConfig(base()).ingestToken, INGEST_TOKEN);
});
