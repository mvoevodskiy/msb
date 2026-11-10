import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32Decode, base32Encode, generateSecret, groupSecret, hotp, otpauthUri, stepAt, totpAt, verifyTotp } from '../../src/server/totp.ts';

// RFC 6238, приложение B: ключ SHA1 — ASCII «12345678901234567890», 8 цифр.
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('TOTP: векторы RFC 6238 (SHA1, 8 цифр)', () => {
  for (const [sec, code] of RFC_VECTORS) {
    assert.equal(hotp(RFC_KEY, Math.floor(sec / 30), 8), code, `T=${sec}`);
    assert.equal(totpAt(base32Encode(RFC_KEY), sec * 1000, 8), code, `T=${sec} через base32`);
  }
});

test('HOTP: векторы RFC 4226 (6 цифр)', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, i) => assert.equal(hotp(RFC_KEY, i), code));
});

test('base32: известный вектор и круговой перевод', () => {
  assert.equal(base32Encode(RFC_KEY), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq=='), RFC_KEY);
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.throws(() => base32Decode('ABC1'), /base32/);
  const s = generateSecret();
  assert.match(s, /^[A-Z2-7]{32}$/, '20 байт — 32 символа base32');
  assert.equal(base32Decode(s).length, 20);
  assert.notEqual(generateSecret(), s);
});

test('verifyTotp: окно ±1 шаг, мусор не проходит', () => {
  const secret = generateSecret();
  const now = 1_800_000_000_000;
  const cur = stepAt(now);
  assert.equal(verifyTotp(secret, totpAt(secret, now), now, null), cur);
  assert.equal(verifyTotp(secret, totpAt(secret, now - 30_000), now, null), cur - 1, 'предыдущий шаг принимается');
  assert.equal(verifyTotp(secret, totpAt(secret, now + 30_000), now, null), cur + 1, 'следующий шаг принимается');
  assert.equal(verifyTotp(secret, totpAt(secret, now - 60_000), now, null), null, 'два шага назад — нет');
  assert.equal(verifyTotp(secret, totpAt(secret, now + 60_000), now, null), null, 'два шага вперёд — нет');
  assert.equal(verifyTotp(secret, ' ' + totpAt(secret, now).slice(0, 3) + ' ' + totpAt(secret, now).slice(3), now, null), cur, 'пробелы в коде допустимы');
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5']) assert.equal(verifyTotp(secret, bad, now, null), null, bad);
});

test('verifyTotp: повтор уже принятого кода отклоняется', () => {
  const secret = generateSecret();
  const now = 1_800_000_000_000;
  const code = totpAt(secret, now);
  const step = verifyTotp(secret, code, now, null);
  assert.notEqual(step, null);
  assert.equal(verifyTotp(secret, code, now, step), null, 'тот же код второй раз');
  assert.equal(verifyTotp(secret, code, now + 20_000, step), null, 'и через 20 с');
  assert.equal(verifyTotp(secret, totpAt(secret, now - 30_000), now, step), null, 'более старый шаг тоже');
  assert.equal(verifyTotp(secret, totpAt(secret, now + 30_000), now + 30_000, step), step! + 1, 'следующий шаг — можно');
});

test('otpauth: ссылка в ASCII с меткой «Пульт:Михаил»', () => {
  const uri = otpauthUri('JBSWY3DPEHPK3PXP');
  assert.match(uri, /^otpauth:\/\/totp\/[\x21-\x7e]+$/);
  const u = new URL(uri);
  assert.equal(u.host, 'totp');
  assert.equal(decodeURIComponent(u.pathname.slice(1)), 'Пульт:Михаил');
  assert.equal(u.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(u.searchParams.get('issuer'), 'Пульт');
  assert.equal(u.searchParams.get('digits'), '6');
  assert.equal(u.searchParams.get('period'), '30');
  assert.equal(groupSecret('ABCDEFGHIJ'), 'ABCD EFGH IJ');
});
