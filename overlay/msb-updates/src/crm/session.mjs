// Сессия оператора CRM.
// Вход: пароль из CRM_PASSWORD. Выход: cookie portal_crm и csrf для форм.
// Пароль в ссылку не попадает. Пустой пароль CRM не включает.
// Проверка: tests/crm.test.mjs.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'portal_crm';
const MAX_AGE_SEC = 8 * 60 * 60;

export function passwordsMatch(left, right) {
  const a = createHash('sha256').update(String(left)).digest();
  const b = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(a, b);
}

export function createSessionStore({ now = Date.now } = {}) {
  const sessions = new Map();

  function readId(req) {
    const raw = String(req.headers?.cookie || '');
    for (const part of raw.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE) return decodeURIComponent(rest.join('='));
    }
    return '';
  }

  function get(req) {
    const id = readId(req);
    const session = id ? sessions.get(id) : null;
    if (!session || session.expiresAt <= now()) {
      if (id) sessions.delete(id);
      return null;
    }
    return { id, csrf: session.csrf };
  }

  function issue() {
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(18).toString('base64url');
    sessions.set(id, { csrf, expiresAt: now() + MAX_AGE_SEC * 1000 });
    return { id, csrf };
  }

  function revoke(req) {
    const id = readId(req);
    if (id) sessions.delete(id);
  }

  function cookie(id, { secure = false, maxAge = MAX_AGE_SEC } = {}) {
    const secureFlag = secure ? '; Secure' : '';
    return `${COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/crm; Max-Age=${maxAge}${secureFlag}`;
  }

  return { get, issue, revoke, cookie, COOKIE, MAX_AGE_SEC };
}
