import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { initDataSignatureOk, parseInitDataFields, verifyTgWebAppInitData } from '../../src/server/tg-webapp.ts';

/** Собрать initData с верной подписью для тестов. */
function signInitData(botToken: string, fields: Record<string, string>): string {
  const params = new URLSearchParams(fields);
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

/** Синтетический токен/owner — не из доки и не боевой. */
const BOT = '999001:' + 'B'.repeat(35);
const OWNER = '100500';

test('подпись initData: верный токен принимает, чужой — нет', () => {
  const initData = signInitData(BOT, {
    auth_date: '1662771648',
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({
      id: Number(OWNER),
      first_name: 'Test',
      last_name: 'Owner',
      username: 'test_owner',
      language_code: 'ru',
      is_premium: true,
    }),
  });
  assert.equal(initDataSignatureOk(initData, BOT), true);
  assert.equal(initDataSignatureOk(initData, '1:wrong'), false);
});

test('verifyTgWebAppInitData: владелец проходит, чужой и протухшее — нет', () => {
  const authDate = 1_700_000_000;
  const initData = signInitData(BOT, {
    auth_date: String(authDate),
    user: JSON.stringify({ id: Number(OWNER), first_name: 'Михаил', username: 'owner' }),
  });
  const ok = verifyTgWebAppInitData(initData, BOT, OWNER, authDate + 60);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.data.user.id, Number(OWNER));
    assert.equal(ok.data.user.username, 'owner');
  }

  const stranger = signInitData(BOT, {
    auth_date: String(authDate),
    user: JSON.stringify({ id: 1, first_name: 'X' }),
  });
  assert.equal(verifyTgWebAppInitData(stranger, BOT, OWNER, authDate + 60).ok, false);

  const stale = verifyTgWebAppInitData(initData, BOT, OWNER, authDate + 25 * 60 * 60);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error, /устарел/);
});

test('parseInitDataFields: пары через &, значение user с JSON', () => {
  const raw = [
    'query_id=AAHdF6IQAAAAAN0XohDhrOrc',
    'user={"id":100500,"first_name":"Test"}',
    'auth_date=1662771648',
    'hash=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  ].join('&');
  const m = parseInitDataFields(raw);
  assert.equal(m.get('query_id'), 'AAHdF6IQAAAAAN0XohDhrOrc');
  assert.equal(m.get('user'), '{"id":100500,"first_name":"Test"}');
  assert.equal(m.get('auth_date'), '1662771648');
});

test('hash WebView: незакодированный tgWebAppData нельзя резать по первому &', () => {
  // Telegram иногда кладёт поля initData в hash без обёртки encode — тогда split('&')/URLSearchParams портят value.
  const initData = signInitData(BOT, {
    auth_date: '1662771648',
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({
      id: Number(OWNER),
      first_name: 'Test',
      last_name: 'Owner',
      username: 'test_owner',
      language_code: 'ru',
      is_premium: true,
    }),
  });
  const hash = `tgWebAppData=${initData}&tgWebAppVersion=8.0&tgWebAppPlatform=android`;

  const broken = new URLSearchParams(hash).get('tgWebAppData') ?? '';
  assert.equal(broken, 'auth_date=1662771648');
  assert.equal(initDataSignatureOk(broken, BOT), false);

  // Верный: взять до &tgWebAppVersion=.
  const key = 'tgWebAppData=';
  const start = hash.indexOf(key);
  let value = hash.slice(start + key.length);
  const stop = value.search(/&tgWebApp(?:Version|Platform|ThemeParams)=/);
  if (stop >= 0) value = value.slice(0, stop);
  assert.equal(value, initData);
  assert.equal(initDataSignatureOk(value, BOT), true);
});

test('verify: повторно URL-кодированный initData тоже принимается', () => {
  const authDate = 1_700_000_000;
  const initData = signInitData(BOT, {
    auth_date: String(authDate),
    user: JSON.stringify({ id: Number(OWNER), first_name: 'Mikhail' }),
  });
  const wrapped = encodeURIComponent(initData);
  const ok = verifyTgWebAppInitData(wrapped, BOT, OWNER, authDate + 60);
  assert.equal(ok.ok, true);
});

// Telegram HMAC authenticates signature too; only Ed25519's check string omits it.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
test('HMAC includes the optional Ed25519 signature field and rejects its tampering', () => {
  const authDate = 1_700_000_000;
  const fields = { auth_date: String(authDate),
    user: JSON.stringify({ id: Number(OWNER), first_name: 'Test' }),
    signature: 'synthetic-ed25519-signature' };
  const signed = signInitData(BOT, fields);
  assert.equal(verifyTgWebAppInitData(signed, BOT, OWNER, authDate + 60).ok, true);
  const tampered = new URLSearchParams(signed);
  tampered.set('signature', 'changed-signature');
  assert.equal(initDataSignatureOk(tampered.toString(), BOT), false);
  tampered.delete('signature');
  assert.equal(initDataSignatureOk(tampered.toString(), BOT), false);
  const unsignedExtra = new URLSearchParams(signInitData(BOT, {
    auth_date: fields.auth_date, user: fields.user,
  }));
  unsignedExtra.set('signature', fields.signature);
  assert.equal(initDataSignatureOk(unsignedExtra.toString(), BOT), false);
});
