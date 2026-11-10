import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkTotpCode, clearFailures, createSession, deleteSession, enrollTotp, getSession, getTotp, globalFailures,
  ipBlocked, listSessions, PRE_TTL_MS, recordFailure, resetTotp, safeEqual, SESSION_TTL_MS, setPendingSecret, shortUserAgent,
} from '../../src/server/auth.ts';
import { cleanup, openDb } from '../../src/server/db.ts';
import { generateSecret, totpAt } from '../../src/server/totp.ts';
import { tmpDir } from './helpers.ts';

const T0 = 1_800_000_000_000;

test('сессии: полная живёт 4 часа по умолчанию, в базе только хеш, выход удаляет', t => {
  const db = openDb(tmpDir(t));
  t.after(() => db.close());
  const token = createSession(db, 'full', T0, 'Mozilla/5.0 (Linux; Android 14) Chrome/130', '1.2.3.4');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 байта в base64url');
  const stored = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, token);
  assert.match(stored[0].token_hash, /^[0-9a-f]{64}$/);

  assert.ok(getSession(db, token, 'full', T0 + SESSION_TTL_MS - 1));
  assert.equal(getSession(db, token, 'full', T0 + SESSION_TTL_MS), null, 'истекла');
  assert.equal(getSession(db, token, 'pre', T0 + 1), null, 'полная сессия не годится как пред-сессия');
  assert.equal(getSession(db, 'чужой', 'full', T0), null);
  assert.equal(getSession(db, undefined, 'full', T0), null);
  assert.equal(listSessions(db, T0).length, 1);

  deleteSession(db, token);
  assert.equal(getSession(db, token, 'full', T0 + 1), null);
});

test('сессии: пред-сессия 10 минут, хранит секрет подключения; чистка удаляет истёкшие', t => {
  const db = openDb(tmpDir(t));
  t.after(() => db.close());
  const pre = createSession(db, 'pre', T0, null, '1.1.1.1');
  setPendingSecret(db, pre, 'JBSWY3DPEHPK3PXP');
  assert.equal(getSession(db, pre, 'pre', T0 + PRE_TTL_MS - 1)?.pendingSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(getSession(db, pre, 'pre', T0 + PRE_TTL_MS), null);
  assert.equal(getSession(db, pre, 'full', T0), null, 'пред-сессия не пускает в панель');
  createSession(db, 'full', T0, null, null);
  cleanup(db, T0 + PRE_TTL_MS);
  assert.equal((db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 1, 'полная осталась, пред-сессия удалена');
});

test('второй фактор: подключается один раз, повтор кода не проходит, сброс снимает всё', t => {
  const db = openDb(tmpDir(t));
  t.after(() => db.close());
  const secret = generateSecret();
  const code = totpAt(secret, T0);
  const wrong = String((Number(code) + 500_000) % 1_000_000).padStart(6, '0');
  assert.equal(enrollTotp(db, secret, wrong, T0), false, 'неверный код — не подключается');
  assert.equal(getTotp(db), null);
  assert.equal(enrollTotp(db, secret, code, T0), true);
  assert.equal(getTotp(db)?.secret, secret);
  assert.equal(enrollTotp(db, generateSecret(), code, T0), false, 'второй раз — нельзя');

  assert.equal(checkTotpCode(db, code, T0 + 5_000), false, 'код подключения нельзя использовать повторно для входа');
  const next = totpAt(secret, T0 + 30_000);
  assert.equal(checkTotpCode(db, next, T0 + 30_000), true);
  assert.equal(checkTotpCode(db, next, T0 + 31_000), false, 'повтор того же кода');

  createSession(db, 'full', T0, null, null);
  const r = resetTotp(db);
  assert.deepEqual(r, { hadTotp: true, sessions: 1 });
  assert.equal(getTotp(db), null);
});

test('защита от подбора: 5 неудач с IP за 15 минут, общий счётчик за час', t => {
  const db = openDb(tmpDir(t));
  t.after(() => db.close());
  for (let i = 0; i < 4; i++) recordFailure(db, '9.9.9.9', T0 + i * 1000);
  assert.equal(ipBlocked(db, '9.9.9.9', T0 + 5000), false, '4 неудачи — ещё можно');
  recordFailure(db, '9.9.9.9', T0 + 5000);
  assert.equal(ipBlocked(db, '9.9.9.9', T0 + 6000), true, '5 неудач — блок');
  assert.equal(ipBlocked(db, '8.8.8.8', T0 + 6000), false, 'другой IP не задет');
  assert.equal(ipBlocked(db, '9.9.9.9', T0 + 15 * 60_000 + 1), false, 'через 15 минут — снова можно');
  assert.equal(globalFailures(db, T0 + 6000), 5);
  assert.equal(globalFailures(db, T0 + 61 * 60_000), 0);
  clearFailures(db, '9.9.9.9');
  assert.equal(ipBlocked(db, '9.9.9.9', T0 + 6000), false);
});

test('сравнение секретов и браузер для уведомления', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', 'x'), false);
  assert.equal(shortUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'), 'Chrome · Android');
  assert.equal(shortUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'Safari · iOS');
  assert.equal(shortUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'), 'Firefox · Windows');
  assert.equal(shortUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 YaBrowser/24.10 Safari/537.36'), 'Яндекс Браузер · Windows');
  assert.equal(shortUserAgent(null), 'неизвестный браузер');
});
