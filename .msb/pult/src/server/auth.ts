// Вход в Пульт: пароль + TOTP, сессии, защита от подбора.
// В БД хранится только sha256 токена сессии; сам токен живёт лишь в cookie браузера.
// Время передаётся параметром (now) — так тесты проверяют истечение без ожидания.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { kvGet, kvSet, tx, type Db } from './db.ts';
import { verifyTotp } from './totp.ts';

export const SESSION_COOKIE = 'pult_sid';
export const PRE_COOKIE = 'pult_pre';
/** Срок полной сессии по умолчанию (перекрывается PULT_SESSION_HOURS). */
export const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
/** @deprecated имя для совместимости тестов — то же, что DEFAULT_SESSION_TTL_MS. */
export const SESSION_TTL_MS = DEFAULT_SESSION_TTL_MS;
export const PRE_TTL_MS = 10 * 60_000;
/** Билет меню Пульта (долгий, многоразовый) — устаревший путь; Mini App идёт через initData. */
export const TG_LOGIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Одноразовая веб-ссылка из /pult — час на первый вход без живой сессии. */
export const TG_LOGIN_ONCE_TTL_MS = 60 * 60 * 1000;

export const IP_WINDOW_MS = 15 * 60_000;
export const IP_MAX_FAILURES = 5;
export const GLOBAL_WINDOW_MS = 60 * 60_000;
export const GLOBAL_ALERT_FAILURES = 20;

export function sha256(s: string | Buffer): Buffer {
  return createHash('sha256').update(s).digest();
}

/** Сравнение секретов за постоянное время, независимо от длины (сравниваем хеши). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

const tokenHash = (token: string): string => sha256(token).toString('hex');

export interface SessionRow {
  tokenHash: string;
  kind: 'full' | 'pre';
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  userAgent: string | null;
  ip: string | null;
  pendingSecret: string | null;
}

type RawSession = { token_hash: string; kind: 'full' | 'pre'; created_at: number; expires_at: number; last_seen_at: number | null; user_agent: string | null; ip: string | null; pending_secret: string | null };

const toSession = (r: RawSession): SessionRow => ({
  tokenHash: r.token_hash,
  kind: r.kind,
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
  lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
  userAgent: r.user_agent,
  ip: r.ip,
  pendingSecret: r.pending_secret,
});

/** Создать сессию; возвращает токен для cookie. ttlMs — только для full (по умолчанию 4 ч). */
export function createSession(
  db: Db,
  kind: 'full' | 'pre',
  now: number,
  userAgent: string | null,
  ip: string | null,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): string {
  const token = newToken();
  const ttl = kind === 'full' ? ttlMs : PRE_TTL_MS;
  db.prepare('INSERT INTO sessions (token_hash, kind, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tokenHash(token), kind, now, now + ttl, now, (userAgent ?? '').slice(0, 300) || null, ip);
  return token;
}

/** Живая сессия нужного вида по токену из cookie. Отметку «последний раз» обновляем не чаще раза в минуту. */
export function getSession(db: Db, token: string | undefined, kind: 'full' | 'pre', now: number): SessionRow | null {
  if (!token || token.length > 100) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > ?').get(tokenHash(token), kind, now) as RawSession | undefined;
  if (!row) return null;
  const s = toSession(row);
  if (kind === 'full' && (s.lastSeenAt === null || now - s.lastSeenAt > 60_000)) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, s.tokenHash);
    s.lastSeenAt = now;
  }
  return s;
}

export function deleteSession(db: Db, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function setPendingSecret(db: Db, token: string, secret: string): void {
  db.prepare("UPDATE sessions SET pending_secret = ? WHERE token_hash = ? AND kind = 'pre'").run(secret, tokenHash(token));
}

export function listSessions(db: Db, now: number): SessionRow[] {
  return (db.prepare("SELECT * FROM sessions WHERE kind = 'full' AND expires_at > ? ORDER BY created_at").all(now) as RawSession[]).map(toSession);
}

export function clearSessions(db: Db): number {
  return Number(db.prepare('DELETE FROM sessions').run().changes);
}

// ---- второй фактор ----

export interface TotpState { secret: string; enrolledAt: number; lastStep: number | null }

export function getTotp(db: Db): TotpState | null {
  const r = db.prepare('SELECT secret, enrolled_at, last_step FROM totp WHERE id = 1').get() as { secret: string; enrolled_at: number; last_step: number | null } | undefined;
  return r ? { secret: r.secret, enrolledAt: Number(r.enrolled_at), lastStep: r.last_step === null ? null : Number(r.last_step) } : null;
}

/**
 * Проверить код по подключённому секрету и запомнить шаг. Запоминание условное (last_step < шага),
 * поэтому два одновременных входа с одним кодом не пройдут оба.
 */
export function checkTotpCode(db: Db, code: string, now: number): boolean {
  const st = getTotp(db);
  if (!st) return false;
  const step = verifyTotp(st.secret, code, now, st.lastStep);
  if (step === null) return false;
  const r = db.prepare('UPDATE totp SET last_step = ? WHERE id = 1 AND (last_step IS NULL OR last_step < ?)').run(step, step);
  return Number(r.changes) === 1;
}

/** Подключить второй фактор (один раз). false — уже подключён или код неверный. */
export function enrollTotp(db: Db, secret: string, code: string, now: number): boolean {
  const step = verifyTotp(secret, code, now, null);
  if (step === null) return false;
  return tx(db, () => {
    if (getTotp(db)) return false;
    db.prepare('INSERT INTO totp (id, secret, enrolled_at, last_step) VALUES (1, ?, ?, ?)').run(secret, now, step);
    return true;
  });
}

/** Сброс второго фактора и всех сессий (admin reset-2fa). */
export function resetTotp(db: Db): { hadTotp: boolean; sessions: number } {
  return tx(db, () => {
    const hadTotp = Number(db.prepare('DELETE FROM totp').run().changes) > 0;
    return { hadTotp, sessions: clearSessions(db) };
  });
}

// ---- защита от подбора ----

export function recordFailure(db: Db, ip: string, now: number): void {
  db.prepare('INSERT INTO login_failures (t, ip) VALUES (?, ?)').run(now, ip);
}

export function clearFailures(db: Db, ip: string): void {
  db.prepare('DELETE FROM login_failures WHERE ip = ?').run(ip);
}

export function ipBlocked(db: Db, ip: string, now: number): boolean {
  const r = db.prepare('SELECT count(*) AS n FROM login_failures WHERE ip = ? AND t > ?').get(ip, now - IP_WINDOW_MS) as { n: number };
  return Number(r.n) >= IP_MAX_FAILURES;
}

export function globalFailures(db: Db, now: number): number {
  const r = db.prepare('SELECT count(*) AS n FROM login_failures WHERE t > ?').get(now - GLOBAL_WINDOW_MS) as { n: number };
  return Number(r.n);
}

export interface TgLoginTicketOpts {
  /** Срок жизни с now. По умолчанию TG_LOGIN_TTL_MS. */
  ttlMs?: number;
  /** Сжечь после первого успешного входа. */
  once?: boolean;
}

/**
 * Билет для URL (?tg=…): Mini App / одноразовая ссылка / меню.
 * Сервер ставит сессию без initData.
 */
export function issueTgLoginTicket(db: Db, now: number, opts: TgLoginTicketOpts = {}): string {
  const ttl = opts.ttlMs ?? TG_LOGIN_TTL_MS;
  const token = newToken();
  kvSet(db, `tg_login:${tokenHash(token)}`, JSON.stringify({ exp: now + ttl, once: opts.once === true }));
  return token;
}

/** Удалить билет из базы, если запись есть. Формат токена проверяем; срок — нет. */
export function burnTgLoginTicket(db: Db, token: string | null | undefined): void {
  if (!token || token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) return;
  kvSet(db, `tg_login:${tokenHash(token)}`, null);
}

/** Принять билет из ?tg=. Одноразовый — сжигается; многоразовый можно жать снова. */
export function acceptTgLoginTicket(db: Db, token: string | null | undefined, now: number): boolean {
  if (!token || token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) return false;
  const key = `tg_login:${tokenHash(token)}`;
  const raw = kvGet(db, key);
  if (!raw) return false;
  let exp: number;
  let once = false;
  try {
    if (raw.startsWith('{')) {
      const j = JSON.parse(raw) as { exp?: unknown; once?: unknown };
      exp = Number(j.exp);
      once = j.once === true;
    } else {
      exp = Number(raw); // старый формат: только число
    }
  } catch {
    kvSet(db, key, null);
    return false;
  }
  if (!Number.isFinite(exp) || exp <= now) {
    kvSet(db, key, null);
    return false;
  }
  if (once) kvSet(db, key, null);
  return true;
}

/** Коротко о браузере для уведомления о входе: «Chrome · Android». */
export function shortUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'неизвестный браузер';
  const browser =
    /YaBrowser\//.test(ua) ? 'Яндекс Браузер' :
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\/|Opera/.test(ua) ? 'Opera' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\/|CriOS\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' :
    /curl\//.test(ua) ? 'curl' : 'браузер';
  const os =
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X|Macintosh/.test(ua) ? 'macOS' :
    /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${browser} · ${os}` : browser;
}
