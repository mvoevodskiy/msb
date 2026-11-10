// HTTP-обработчик Пульта на node:http: API для сборщика и интерфейса, вход с паролем и TOTP, статика из src/ui.
// Маршруты — в handle(). Всё, что зависит от времени, берёт ctx.now() — для тестов.
//
// Безопасность (не ослаблять без причины):
// - на всех ответах CSP и прочие заголовки из SECURITY_HEADERS;
// - POST, кроме /api/ingest, — только с Origin/Referer этого же хоста (защита от подделки запросов);
// - cookie HttpOnly: обычная SameSite=Lax; HTTPS Mini App — None/Secure/Partitioned; в БД — sha256;
// - IP клиента из X-Real-IP/X-Forwarded-For берём, только если соединение пришло с локального адреса и PULT_TRUST_PROXY=1.

import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import type { Alerter } from './alerts.ts';
import {
  acceptTgLoginTicket, burnTgLoginTicket, checkTotpCode, clearFailures, createSession, deleteSession, enrollTotp, getSession, getTotp,
  globalFailures, GLOBAL_ALERT_FAILURES, ipBlocked, issueTgLoginTicket, PRE_COOKIE, PRE_TTL_MS, recordFailure, safeEqual,
  SESSION_COOKIE, setPendingSecret, shortUserAgent, TG_LOGIN_ONCE_TTL_MS,
} from './auth.ts';
import { listTgAuthCandidates } from './tg-bots.ts';
import type { Config } from './config.ts';
import { getSnapshot, kvGet, kvSet, type Db } from './db.ts';
import type { Log } from './log.ts';
import { enrollPage, loginPage, messagePage } from './pages.ts';
import { history, IngestError, isRange, snapshotResponseJson, storeSnapshot, validateSnapshot } from './snapshot.ts';
import { esc, type Notifier } from './telegram.ts';
import { verifyTgWebAppInitData } from './tg-webapp.ts';
import { generateSecret } from './totp.ts';

export const INGEST_LIMIT = 5 * 1024 * 1024;
const FORM_LIMIT = 16 * 1024;
const INGEST_LOG_EVERY_MS = 10 * 60_000;

// frame-ancestors: Mini App в Telegram Web открывается во фрейме web.telegram.org —
// 'none'/DENY ломает вход с веб-клиента. Остальным сайтам встраивать по-прежнему нельзя.
// X-Frame-Options не ставим: он перекрыл бы разрешённые frame-ancestors.
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org; form-action 'self'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  // same-origin, а не no-referrer: при no-referrer браузер шлёт в POST-формах «Origin: null»,
  // и проверка Origin не отличила бы свою форму от чужой. Наружу Referer не уходит и так.
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface AppContext {
  cfg: Config;
  db: Db;
  notifier: Notifier;
  alerter: Alerter;
  log: Log;
  now: () => number;
  /** Каталог статики интерфейса (src/ui). */
  uiDir: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

const sizeText = (bytes: number): string => (bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} МБ` : `${Math.round(bytes / 1024)} КБ`);

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, `Тело больше ${sizeText(limit)}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `Тело больше ${sizeText(limit)}`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const normIp = (ip: string | undefined): string => (ip ?? '').replace(/^::ffff:/, '');
const isLoopback = (ip: string): boolean => ip === '127.0.0.1' || ip === '::1';

export function createApp(ctx: AppContext): (req: IncomingMessage, res: ServerResponse) => void {
  const { cfg, db, log } = ctx;
  const uiDir = resolve(ctx.uiDir);
  const publicOrigin = new URL(cfg.publicUrl).origin;
  let lastIngestLog = 0;
  let lastBadTokenLog = 0;

  // Ordinary browser/TOTP sessions keep Lax. Mini App has a separate cookie so
  // embedded and top-level sessions cannot shadow each other.
  const cookie = (name: string, value: string, maxAgeSec: number, path: string): string =>
    `${name}=${value}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${cfg.cookieSecure ? '; Secure' : ''}`;

  const tgSessionCookie = (value: string, maxAgeSec: number): string =>
    `pult_tg_sid=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; ${cfg.cookieSecure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax'}`;

  function clientIp(req: IncomingMessage): string {
    const remote = normIp(req.socket.remoteAddress);
    if (cfg.trustProxy && isLoopback(remote)) {
      const real = String(req.headers['x-real-ip'] ?? '').trim();
      if (isIP(normIp(real))) return normIp(real);
      const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => normIp(s.trim())).filter(s => isIP(s));
      if (xff.length) return xff[xff.length - 1];
    }
    return remote || 'неизвестно';
  }

  /** Запрос пришёл со страницы этого же сайта. */
  function sameOrigin(req: IncomingMessage): boolean {
    const hosts = new Set<string>();
    if (req.headers.host) hosts.add(req.headers.host.toLowerCase());
    const remote = normIp(req.socket.remoteAddress);
    if (cfg.trustProxy && isLoopback(remote) && typeof req.headers['x-forwarded-host'] === 'string') {
      hosts.add(req.headers['x-forwarded-host'].split(',')[0].trim().toLowerCase());
    }
    const matches = (value: string): boolean => {
      try {
        const u = new URL(value);
        return u.origin === publicOrigin || hosts.has(u.host.toLowerCase());
      } catch {
        return false;
      }
    };
    const origin = req.headers.origin;
    if (origin && origin !== 'null') return matches(origin);
    // «Origin: null» браузер шлёт, если у страницы политика no-referrer; Sec-Fetch-Site со страницы не подделать.
    if (origin === 'null') return req.headers['sec-fetch-site'] === 'same-origin';
    const referer = req.headers.referer;
    return typeof referer === 'string' && matches(referer);
  }

  function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string | string[]> = {}): void {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
    res.end(body);
  }
  const html = (res: ServerResponse, status: number, body: string, extra: Record<string, string | string[]> = {}): void =>
    send(res, status, body, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store', ...extra });
  const json = (res: ServerResponse, status: number, body: unknown): void =>
    send(res, status, typeof body === 'string' ? body : JSON.stringify(body), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
  const text = (res: ServerResponse, status: number, body: string): void =>
    send(res, status, body, 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
  const redirect = (res: ServerResponse, location: string, cookies: string[] = []): void => {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': 0, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
    res.end();
  };

  const fullSession = (req: IncomingMessage) => {
    const cookies = parseCookies(req.headers.cookie);
    return getSession(db, cookies.pult_tg_sid, 'full', ctx.now())
      ?? getSession(db, cookies[SESSION_COOKIE], 'full', ctx.now());
  };

  function notify(textHtml: string, kind: string): void {
    void ctx.notifier.send(textHtml, kind).catch(() => { /* ошибка уже записана в notify.lastError */ });
  }

  /** Неудача входа: учесть, а если со всех IP за час больше 20 — одна тревога в час. */
  function loginFailed(ip: string, where: string): void {
    const now = ctx.now();
    recordFailure(db, ip, now);
    log(`${where}: неудача, IP ${ip}`);
    const n = globalFailures(db, now);
    if (n > GLOBAL_ALERT_FAILURES) {
      const last = Number(kvGet(db, 'bruteforce_alert_at') ?? 0);
      if (now - last >= 3_600_000) {
        kvSet(db, 'bruteforce_alert_at', String(now));
        log(`тревога: подбор пароля, ${n} неудач за час`);
        notify(`🔴 Нужно от тебя: проверить — кто-то подбирает пароль к Пульту (${n} неудачных попыток за час)`, 'bruteforce');
      }
    }
  }

  const blockedText = 'Слишком много попыток, подожди 15 минут';

  async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    return new URLSearchParams((await readBody(req, FORM_LIMIT)).toString('utf8'));
  }

  const sessionCookieMaxAge = () => Math.floor(cfg.sessionTtlMs / 1000);

  /** Вход из Mini App: HMAC initData бота, открывшего web_app + id = владелец. */
  async function postTgAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req);
    const candidates = listTgAuthCandidates(cfg.tg);
    if (!candidates.length) {
      return json(res, 503, {
        error: 'Нет токена для проверки Mini App: нужен BOT_TOKEN у MSB-бота или PULT_TG_TOKEN',
      });
    }
    if (ipBlocked(db, ip, ctx.now())) {
      log(`вход Mini App: отказ, IP ${ip} — слишком много попыток`);
      return json(res, 429, { error: blockedText });
    }
    let initData = '';
    try {
      const raw = (await readBody(req, FORM_LIMIT)).toString('utf8');
      const parsed = JSON.parse(raw) as { initData?: unknown };
      initData = typeof parsed.initData === 'string' ? parsed.initData : '';
    } catch {
      return json(res, 400, { error: 'Ожидается JSON { initData }' });
    }
    const nowSec = Math.floor(ctx.now() / 1000);
    let verified: ReturnType<typeof verifyTgWebAppInitData> | null = null;
    let matchedSource = '';
    for (const c of candidates) {
      const r = verifyTgWebAppInitData(initData, c.token, c.chatId, nowSec);
      if (r.ok) {
        verified = r;
        matchedSource = c.source;
        break;
      }
      // Чужой владелец при верной подписи этого бота — стоп, не перебираем дальше как «не та подпись».
      if (!r.ok && r.error.includes('не чат владельца')) {
        verified = r;
        matchedSource = c.source;
        break;
      }
    }
    if (!verified || !verified.ok) {
      const err = verified && !verified.ok ? verified.error : 'подпись Mini App неверна';
      const foreign = err.includes('не чат владельца');
      if (foreign) loginFailed(ip, 'вход Mini App');
      else log(`вход Mini App: отказ, IP ${ip} — ${err}`);
      return json(res, 401, { error: err });
    }
    clearFailures(db, ip);
    const ua = req.headers['user-agent'] ?? null;
    const token = createSession(db, 'full', ctx.now(), ua, ip, cfg.sessionTtlMs);
    const who = verified.data.user.username ? `@${verified.data.user.username}` : `id ${verified.data.user.id}`;
    log(`вход Mini App: ${who}, IP ${ip} (${shortUserAgent(ua)}, ${matchedSource})`);
    notify(`🟢 От тебя ничего не нужно\n\nВход в Пульт из Telegram Mini App: ${esc(who)}, ${esc(shortUserAgent(ua))}, IP ${esc(ip)}`, 'login-tg');
    res.writeHead(204, {
      'Cache-Control': 'no-store',
      'Content-Length': 0,
      'Set-Cookie': tgSessionCookie(token, sessionCookieMaxAge()),
    });
    res.end();
  }

  // ---- вход ----

  async function postLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req);
    const enrolled = getTotp(db) !== null;
    if (ipBlocked(db, ip, ctx.now())) {
      log(`вход: отказ, IP ${ip} — слишком много попыток`);
      return html(res, 429, loginPage({ enrolled, error: blockedText }), { 'Retry-After': '900' });
    }
    const form = await readForm(req);
    const password = form.get('password') ?? '';
    const code = (form.get('code') ?? '').replace(/\s/g, '');
    const passOk = safeEqual(password, cfg.password);
    // Шаг TOTP «тратим» только при верном пароле — иначе чужой мог бы сжечь текущий код владельца.
    const ok = enrolled ? passOk && checkTotpCode(db, code, ctx.now()) : passOk;
    if (!ok) {
      loginFailed(ip, 'вход');
      return html(res, 401, loginPage({ enrolled, error: 'Неверный пароль или код' }));
    }
    clearFailures(db, ip);
    const ua = req.headers['user-agent'] ?? null;
    if (!enrolled) {
      const pre = createSession(db, 'pre', ctx.now(), ua, ip);
      log(`вход: пароль верный, IP ${ip} — подключение второго фактора`);
      return redirect(res, '/enroll', [cookie(PRE_COOKIE, pre, PRE_TTL_MS / 1000, '/enroll')]);
    }
    const token = createSession(db, 'full', ctx.now(), ua, ip, cfg.sessionTtlMs);
    log(`вход: успешно, IP ${ip} (${shortUserAgent(ua)})`);
    notify(`🟢 От тебя ничего не нужно\n\nВход в Пульт: ${esc(shortUserAgent(ua))}, IP ${esc(ip)}`, 'login');
    redirect(res, '/', [cookie(SESSION_COOKIE, token, sessionCookieMaxAge(), '/')]);
  }

  function preSession(req: IncomingMessage) {
    const token = parseCookies(req.headers.cookie)[PRE_COOKIE];
    const s = getSession(db, token, 'pre', ctx.now());
    return s && token ? { s, token } : null;
  }

  function getEnroll(req: IncomingMessage, res: ServerResponse): void {
    const pre = preSession(req);
    if (!pre || getTotp(db)) return redirect(res, '/login');
    let secret = pre.s.pendingSecret;
    if (!secret) {
      // Секрет держим в пред-сессии: обновление страницы показывает тот же QR, что уже отсканирован.
      secret = generateSecret();
      setPendingSecret(db, pre.token, secret);
    }
    html(res, 200, enrollPage(secret, null));
  }

  async function postEnroll(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req);
    const pre = preSession(req);
    if (!pre || !pre.s.pendingSecret || getTotp(db)) return redirect(res, '/login');
    if (ipBlocked(db, ip, ctx.now())) {
      log(`второй фактор: отказ, IP ${ip} — слишком много попыток`);
      return html(res, 429, enrollPage(pre.s.pendingSecret, blockedText), { 'Retry-After': '900' });
    }
    const form = await readForm(req);
    const code = (form.get('code') ?? '').replace(/\s/g, '');
    if (!enrollTotp(db, pre.s.pendingSecret, code, ctx.now())) {
      if (getTotp(db)) return redirect(res, '/login');
      loginFailed(ip, 'второй фактор');
      return html(res, 401, enrollPage(pre.s.pendingSecret, 'Неверный код. Проверь, что время на телефоне выставлено автоматически, и введи свежий код.'));
    }
    deleteSession(db, pre.token);
    clearFailures(db, ip);
    const ua = req.headers['user-agent'] ?? null;
    const token = createSession(db, 'full', ctx.now(), ua, ip, cfg.sessionTtlMs);
    log(`второй фактор подключён, вход: IP ${ip} (${shortUserAgent(ua)})`);
    notify(`🟢 От тебя ничего не нужно\n\nК Пульту подключён второй фактор входа\nУстройство: ${esc(shortUserAgent(ua))}, IP ${esc(ip)}`, 'enroll');
    redirect(res, '/', [cookie(SESSION_COOKIE, token, sessionCookieMaxAge(), '/'), cookie(PRE_COOKIE, '', 0, '/enroll')]);
  }

  // ---- API ----

  function bearerIngestOk(req: IncomingMessage): boolean {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization ?? ''));
    return Boolean(m && safeEqual(m[1], cfg.ingestToken));
  }

  /** POST /api/bot/ticket { kind: "once" } — одноразовая веб-ссылка (без сессии сжигается). */
  async function issueBotTicket(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!bearerIngestOk(req)) {
      log(`билет бота отклонён: неверный токен, IP ${clientIp(req)}`);
      return json(res, 401, { error: 'Нужен Authorization: Bearer <PULT_INGEST_TOKEN>' });
    }
    try {
      const body = await readBody(req, FORM_LIMIT);
      if (body.length) {
        const data = JSON.parse(body.toString('utf8')) as { kind?: unknown };
        if (data.kind !== undefined && data.kind !== 'once') {
          return json(res, 400, { error: 'kind: только once (Mini App входит через initData)' });
        }
      }
    } catch (e) {
      return json(res, 400, { error: `Тело — не JSON: ${(e as Error).message}` });
    }
    const now = ctx.now();
    const ttlMs = TG_LOGIN_ONCE_TTL_MS;
    const ticket = issueTgLoginTicket(db, now, { ttlMs, once: true });
    const base = cfg.publicUrl.replace(/\/+$/, '');
    const url = `${base}/?tg=${encodeURIComponent(ticket)}`;
    return json(res, 200, { kind: 'once', url, expiresAt: new Date(now + ttlMs).toISOString(), once: true, ttlSec: Math.floor(ttlMs / 1000) });
  }

  async function ingest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!bearerIngestOk(req)) {
      const now = ctx.now();
      if (now - lastBadTokenLog > 60_000) {
        lastBadTokenLog = now;
        log(`снимок отклонён: неверный токен, IP ${clientIp(req)}`);
      }
      return text(res, 401, !/^Bearer\s+\S+\s*$/i.test(String(req.headers.authorization ?? ''))
        ? 'Нужен заголовок Authorization: Bearer <токен сборщика>'
        : 'Неверный токен сборщика');
    }
    const body = await readBody(req, INGEST_LIMIT);
    let data: unknown;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch (e) {
      return text(res, 400, `Тело — не JSON: ${(e as Error).message}`);
    }
    let snap;
    try {
      snap = validateSnapshot(data);
    } catch (e) {
      if (e instanceof IngestError) return text(res, 400, `Снимок не принят: ${e.message}`);
      throw e;
    }
    const now = ctx.now();
    const size = storeSnapshot(db, snap, now);
    if (now - lastIngestLog >= INGEST_LOG_EVERY_MS) {
      lastIngestLog = now;
      log(`снимок принят: ${Math.round(size / 1024)} КБ, сбор ${Math.round(Number(snap.collectMs) || 0)} мс`);
    }
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    ctx.alerter.onSnapshot(snap.attention, now);
  }

  // ---- статика ----

  async function serveFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
    let st;
    try {
      st = await stat(file);
    } catch {
      st = null;
    }
    if (!st || !st.isFile()) return text(res, 404, 'Не найдено');
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(body);
  }

  /** Путь внутри uiDir или null (выход за каталог, скрытые файлы, мусор в адресе). */
  function uiPath(rel: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return null;
    }
    if (!decoded || decoded.includes('\0') || decoded.includes('\\')) return null;
    if (decoded.split('/').some(seg => seg.startsWith('.'))) return null;
    const full = resolve(uiDir, decoded);
    return full.startsWith(uiDir + sep) ? full : null;
  }

  // ---- маршруты ----

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return text(res, 400, 'Неверный адрес');
    }
    const path = url.pathname;

    if (path === '/api/ingest') {
      if (method !== 'POST') return text(res, 405, 'Только POST');
      return ingest(req, res);
    }
    // Билеты для /pult любого MSB-бота (Bearer = токен сборщика). Без проверки Origin.
    if (path === '/api/bot/ticket') {
      if (method !== 'POST') return json(res, 405, { error: 'Только POST' });
      return issueBotTicket(req, res);
    }
    if (method === 'POST' && !sameOrigin(req)) {
      const from = String(req.headers.origin ?? req.headers.referer ?? 'нет').slice(0, 100).replace(/[\r\n]/g, ' ');
      log(`запрос отклонён: чужой Origin (${from}) на ${path.slice(0, 100)}, IP ${clientIp(req)}`);
      return text(res, 403, 'Запрос не с этой страницы — отклонён');
    }

    // Одноразовая веб-ссылка (?tg=…):
    // — без сессии: принять билет → сессия, билет сгорает;
    // — с живой сессией: билет не проверяем для входа, но всё равно сжигаем (повторно без сессии не пустит).
    if (method === 'GET' && (path === '/' || path === '/index.html' || path === '/login')) {
      const ticket = url.searchParams.get('tg');
      if (ticket) {
        if (fullSession(req)) {
          burnTgLoginTicket(db, ticket);
          return redirect(res, '/'); // Do not retain the consumed ticket in the browser address.
        } else if (acceptTgLoginTicket(db, ticket, ctx.now())) {
          const ip = clientIp(req);
          const ua = req.headers['user-agent'] ?? null;
          clearFailures(db, ip);
          const token = createSession(db, 'full', ctx.now(), ua, ip, cfg.sessionTtlMs);
          log(`вход по одноразовой ссылке, IP ${ip} (${shortUserAgent(ua)})`);
          notify(`🟢 От тебя ничего не нужно\n\nВход в Пульт по одноразовой ссылке, ${esc(shortUserAgent(ua))}, IP ${esc(ip)}`, 'login-tg');
          return redirect(res, '/', [cookie(SESSION_COOKIE, token, sessionCookieMaxAge(), '/')]);
        }
      }
    }

    switch (path) {
      case '/health': {
        if (method !== 'GET') return text(res, 405, 'Только GET');
        const row = getSnapshot(db);
        return json(res, 200, { ok: true, snapshotAgeSec: row ? Math.max(0, Math.floor((ctx.now() - row.receivedAt) / 1000)) : null });
      }
      case '/login':
        if (method === 'GET') {
          if (fullSession(req)) return redirect(res, '/');
          return html(res, 200, loginPage({ enrolled: getTotp(db) !== null, error: null }));
        }
        if (method === 'POST') return postLogin(req, res);
        return text(res, 405, 'Только GET и POST');
      case '/api/tg-auth':
        if (method !== 'POST') return json(res, 405, { error: 'Только POST' });
        return postTgAuth(req, res);
      case '/enroll':
        if (method === 'GET') return getEnroll(req, res);
        if (method === 'POST') return postEnroll(req, res);
        return text(res, 405, 'Только GET и POST');
      case '/logout': {
        if (method !== 'POST') return text(res, 405, 'Только POST');
        const cookies = parseCookies(req.headers.cookie);
        if (fullSession(req)) log(`выход, IP ${clientIp(req)}`);
        deleteSession(db, cookies[SESSION_COOKIE]);
        deleteSession(db, cookies.pult_tg_sid);
        return redirect(res, '/login', [cookie(SESSION_COOKIE, '', 0, '/'), tgSessionCookie('', 0)]);
      }
      case '/ui/auth.css':
        if (method !== 'GET') return text(res, 405, 'Только GET');
        return serveFile(req, res, resolve(uiDir, 'auth.css'));
      case '/ui/tg-bridge.js':
        // Мост Mini App нужен на странице входа до сессии.
        if (method !== 'GET') return text(res, 405, 'Только GET');
        return serveFile(req, res, resolve(uiDir, 'tg-bridge.js'));
      case '/favicon.svg':
        if (method !== 'GET') return text(res, 405, 'Только GET');
        return serveFile(req, res, resolve(uiDir, 'favicon.svg'));
    }

    const session = fullSession(req);

    if (path.startsWith('/api/')) {
      if (!session) return json(res, 401, { error: 'Нужен вход' });
      if (method !== 'GET') return json(res, 405, { error: 'Только GET' });
      if (path === '/api/snapshot') return json(res, 200, snapshotResponseJson(db, ctx.now(), cfg.staleSec, ctx.notifier.status()));
      if (path === '/api/history') {
        const range = url.searchParams.get('range') ?? '24h';
        if (!isRange(range)) return json(res, 400, { error: 'range — одно из: 24h, 7d, 30d' });
        return json(res, 200, history(db, range, ctx.now()));
      }
      return json(res, 404, { error: 'Нет такого метода API' });
    }

    if (method !== 'GET') return text(res, 405, 'Метод не поддерживается');

    if (path.startsWith('/ui/')) {
      if (!session) return text(res, 401, 'Нужен вход');
      const file = uiPath(path.slice('/ui/'.length));
      if (!file) return text(res, 404, 'Не найдено');
      return serveFile(req, res, file);
    }

    // Без сессии на «/» отдаём страницу входа с 200, а не 302 на /login:
    // редирект в WebView Telegram часто срезает #tgWebAppData=… — без него Mini App не входит.
    if (!session) {
      if (path === '/' || path === '/index.html' || path === '/login') {
        return html(res, 200, loginPage({ enrolled: getTotp(db) !== null, error: null }));
      }
      return redirect(res, '/login');
    }
    if (path === '/' || path === '/index.html') {
      const index = resolve(uiDir, 'index.html');
      try {
        await stat(index);
      } catch {
        return html(res, 503, messagePage('нет интерфейса', 'Интерфейс панели не найден на сервере (src/ui/index.html). Сервис работает, данные принимаются.'));
      }
      return serveFile(req, res, index);
    }
    return html(res, 404, messagePage('не найдено', 'Такой страницы нет.'));
  }

  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) {
        if (!res.headersSent) {
          res.setHeader('Connection', 'close');
          text(res, e.status, e.message);
        }
        // Не дочитываем огромное тело — закрываем соединение после ответа.
        if (e.status === 413) res.on('finish', () => req.destroy());
        return;
      }
      log(`ошибка обработки ${req.method} ${String(req.url).split('?')[0]}: ${(e as Error).message}`);
      if (!res.headersSent) text(res, 500, 'Внутренняя ошибка Пульта');
      else res.destroy();
    });
  };
}
