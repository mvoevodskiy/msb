// Второй фактор входа: TOTP по RFC 6238 (HMAC-SHA1, шаг 30 с, 6 цифр) на node:crypto, без зависимостей.
// Окно проверки ±1 шаг; повтор уже принятого кода отсекается по номеру шага (lastStep хранится в БД).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SEC = 30;
export const DIGITS = 6;

/** Base32 по RFC 4648, без «=» — так ключ принимают все приложения-аутентификаторы. */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Пробелы, дефисы, «=» и регистр игнорируются. Неверный символ — ошибка. */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('ключ TOTP: недопустимый символ base32');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Новый секрет: 20 случайных байт (как рекомендует RFC 4226 для SHA1), в base32. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(key: Uint8Array, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function stepAt(timeMs: number): number {
  return Math.floor(timeMs / 1000 / STEP_SEC);
}

export function totpAt(secretB32: string, timeMs: number, digits = DIGITS): string {
  return hotp(base32Decode(secretB32), stepAt(timeMs), digits);
}

/**
 * Проверить код. Возвращает номер принятого шага (его нужно сохранить как lastStep) или null.
 * Код, совпавший с шагом ≤ lastStep, не принимается — это повтор.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastStep: number | null, window = 1): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const cur = stepAt(nowMs);
  const given = Buffer.from(c);
  let accepted: number | null = null;
  // Проверяем все шаги окна, чтобы время ответа не зависело от того, какой совпал.
  for (let s = cur - window; s <= cur + window; s++) {
    if (timingSafeEqual(Buffer.from(hotp(key, s)), given) && accepted === null) accepted = s;
  }
  if (accepted === null) return null;
  if (lastStep !== null && accepted <= lastStep) return null;
  return accepted;
}

/** Ссылка для QR-кода. Метка и издатель — в процентной кодировке, чтобы QR остался в байтовом ASCII. */
export function otpauthUri(secretB32: string, issuer = 'Пульт', account = 'Михаил'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SEC}`;
}

/** Секрет группами по 4 — удобно вводить руками. */
export function groupSecret(secretB32: string): string {
  return secretB32.replace(/(.{4})/g, '$1 ').trim();
}
