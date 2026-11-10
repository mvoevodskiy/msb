import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, fmtCores, fmtCount, fmtDate, fmtDateTime, fmtMb, fmtNumber, fmtRub, fmtTime, fmtUsd, fmtWhen, plural } from '../../src/shared/format.ts';

test('время и даты по Москве', () => {
  assert.equal(fmtTime('2026-10-29T10:45:00Z'), '13:45');
  assert.equal(fmtTime(new Date('2026-10-28T21:02:51Z')), '00:02');
  assert.equal(fmtDate('2026-10-28T21:02:51Z'), '29.10');
  assert.equal(fmtDateTime(Date.parse('2026-10-28T20:25:00Z')), '28.10 23:25');
  assert.equal(fmtTime('2026-10-29T10:45:00Z', 'UTC'), '10:45');
});

test('«13:45» сегодня, «28.10 23:25» в другие дни (по Москве)', () => {
  const now = '2026-10-29T10:45:00Z';
  assert.equal(fmtWhen('2026-10-28T21:02:00Z', now), '00:02');
  assert.equal(fmtWhen('2026-10-28T20:25:00Z', now), '28.10 23:25');
});

test('числа по-русски', () => {
  assert.equal(fmtNumber(6037), '6 037');
  assert.equal(fmtNumber(1234567.891, 2), '1 234 567,89');
  assert.equal(fmtNumber(2.5, 2, 2), '2,50');
  assert.equal(fmtNumber(2.0, 2), '2');
  assert.equal(fmtNumber(-1500), '-1 500');
  assert.equal(fmtNumber(NaN), '—');
});

test('количества: тыс., млн, млрд', () => {
  assert.equal(fmtCount(8_367_471), '8,4 млн');
  assert.equal(fmtCount(9_000_000), '9,0 млн');
  assert.equal(fmtCount(43_994), '44 тыс.');
  assert.equal(fmtCount(43_000), '43 тыс.');
  assert.equal(fmtCount(999_600), '1,0 млн');
  assert.equal(fmtCount(512), '512');
  assert.equal(fmtCount(1_234_000_000), '1,2 млрд');
});

test('память: МБ и ГБ', () => {
  assert.equal(fmtMb(4505), '4,4 ГБ');
  assert.equal(fmtMb(236), '236 МБ');
  assert.equal(fmtMb(1024), '1,0 ГБ');
  assert.equal(fmtMb(1023.6), '1 024 МБ');
});

test('деньги: рубли и доллары', () => {
  assert.equal(fmtRub(334.75), '334,75 ₽');
  assert.equal(fmtRub(334.7), '334,70 ₽');
  assert.equal(fmtRub(1200), '1 200 ₽');
  assert.equal(fmtUsd(0.00464), '$0,005');
  assert.equal(fmtUsd(0.0073839), '$0,007');
  assert.equal(fmtUsd(5), '$5');
  assert.equal(fmtUsd(199.89790582), '$199,90');
  assert.equal(fmtUsd(11.1872), '$11,19');
  assert.equal(fmtUsd(0.5), '$0,50');
  assert.equal(fmtUsd(0), '$0');
  assert.equal(fmtUsd(0.0001), '<$0,001');
});

test('склонения и ядра', () => {
  assert.equal(plural(1, 'ход', 'хода', 'ходов'), 'ход');
  assert.equal(plural(3, 'ход', 'хода', 'ходов'), 'хода');
  assert.equal(plural(15, 'ход', 'хода', 'ходов'), 'ходов');
  assert.equal(plural(21, 'ход', 'хода', 'ходов'), 'ход');
  assert.equal(plural(112, 'ход', 'хода', 'ходов'), 'ходов');
  assert.equal(fmtCores(0.89), '≈0,9 ядра');
  assert.equal(fmtCores(1.02), '≈1 ядро');
  assert.equal(fmtCores(2), '≈2 ядра');
  assert.equal(fmtCores(5), '≈5 ядер');
});

test('обрезка текста: одна строка, «…», эмодзи не рвутся', () => {
  assert.equal(clip('  а\n\nб  в ', 10), 'а б в');
  assert.equal(clip('abcdefghij', 5), 'abcd…');
  assert.equal(clip('🟢🟢🟢🟢', 3), '🟢🟢…');
});
