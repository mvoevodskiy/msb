// Предпросмотр интерфейса без настоящего веб-сервиса: отдаёт src/ui и фикстуры по путям API.
// Запуск: node tests/ui/preview-server.ts [--port 8790]   → http://127.0.0.1:8790/?fx=full
// Фикстура выбирается параметром ?fx=<имя> на странице (запоминается в куке fx) или кукой напрямую:
//   full — обычный снимок; stale — данные устарели; empty — сборщик ещё не прислал данные; quiet — нет задач,
//   вопросов и тревог, но есть ошибки источников; offline — обрыв связи; unauth — 401 (уход на /login);
//   error500 — сервер отвечает 500; nohist — история не загружается.
// Заголовки CSP — как у настоящего сервиса: инлайн-скрипты и обработчики в разметке не пройдут.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SnapshotResponse, Snapshot } from '../../src/shared/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI = join(ROOT, 'src', 'ui');
const FX = join(ROOT, 'tests', 'fixtures', 'ui');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org";
export const FIXTURES = ['full', 'stale', 'empty', 'quiet', 'offline', 'unauth', 'error500', 'nohist'] as const;

const json = (name: string): Snapshot => JSON.parse(readFileSync(join(FX, name), 'utf8'));
const notify = { configured: true, lastError: null, lastSentAt: '2026-10-29T05:00:02.000Z' };

/** Ответ /api/snapshot для фикстуры (null — «обрыв связи»). */
export function snapshotResponse(fx: string): SnapshotResponse | null {
  const snap = json('snapshot.json');
  switch (fx) {
    case 'stale': return { snapshot: snap, receivedAt: '2026-10-29T10:45:00.000Z', ageSec: 750, stale: true, notify };
    case 'empty': return { snapshot: null, receivedAt: null, ageSec: null, stale: false, notify };
    case 'quiet': return { snapshot: json('snapshot-quiet.json'), receivedAt: '2026-10-29T10:45:00.000Z', ageSec: 20, stale: false,
      notify: { configured: true, lastError: 'Telegram ответил 403: бот удалён из чата', lastSentAt: '2026-10-28T05:00:02.000Z' } };
    case 'offline': return null;
    default: return { snapshot: snap, receivedAt: '2026-10-29T10:45:00.000Z', ageSec: 20, stale: false, notify };
  }
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', ...extra });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const qfx = url.searchParams.get('fx');
  const fx = qfx ?? cookie(req, 'fx') ?? 'full';
  const setCookie: Record<string, string> = qfx ? { 'set-cookie': `fx=${encodeURIComponent(qfx)}; Path=/; SameSite=Lax` } : {};

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, TYPES['.html']!, await readFile(join(UI, 'index.html')), setCookie);
  }
  if (url.pathname.startsWith('/ui/')) {
    const rel = normalize(decodeURIComponent(url.pathname.slice(4))).replace(/^(\.\.[/\\])+/, '');
    const file = join(UI, rel);
    if (!file.startsWith(UI + '/')) return send(res, 403, 'text/plain; charset=utf-8', 'нельзя');
    try { return send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', await readFile(file)); }
    catch { return send(res, 404, 'text/plain; charset=utf-8', 'нет такого файла'); }
  }
  if (url.pathname === '/api/snapshot') {
    if (fx === 'unauth') return send(res, 401, TYPES['.json']!, '{"error":"нужен вход"}');
    if (fx === 'error500') return send(res, 500, TYPES['.json']!, '{"error":"сбой"}');
    const body = snapshotResponse(fx);
    if (!body) { req.socket.destroy(); return; }
    return send(res, 200, TYPES['.json']!, JSON.stringify(body));
  }
  if (url.pathname === '/api/history') {
    if (fx === 'unauth') return send(res, 401, TYPES['.json']!, '{"error":"нужен вход"}');
    if (fx === 'nohist' || fx === 'offline') return send(res, 503, TYPES['.json']!, '{"error":"нет истории"}');
    const range = url.searchParams.get('range');
    if (range !== '24h' && range !== '7d' && range !== '30d') return send(res, 400, TYPES['.json']!, '{"error":"range"}');
    // Небольшая задержка — чтобы было видно состояние «загружаю».
    await new Promise((r) => setTimeout(r, 60));
    return send(res, 200, TYPES['.json']!, await readFile(join(FX, `history-${range}.json`)));
  }
  if (url.pathname === '/login' || url.pathname === '/enroll') {
    try {
      const pages = await import('../../src/server/pages.ts');
      const html = url.pathname === '/login'
        ? pages.loginPage({ enrolled: url.searchParams.get('first') == null, error: url.searchParams.get('err') ? 'Неверный пароль или код. Осталось попыток: 4.' : null })
        : pages.enrollPage('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', null);
      return send(res, 200, TYPES['.html']!, html);
    } catch (e) {
      return send(res, 500, 'text/plain; charset=utf-8', `страницы входа недоступны: ${(e as Error).message}`);
    }
  }
  if (url.pathname === '/logout' && req.method === 'POST') return send(res, 303, 'text/plain; charset=utf-8', '', { location: '/login' });
  return send(res, 404, 'text/plain; charset=utf-8', 'нет такой страницы');
}

export function startPreview(port = 0): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => { handle(req, res).catch((e) => send(res, 500, 'text/plain; charset=utf-8', String(e))); });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ url: `http://127.0.0.1:${p}`, server, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 8790;
  startPreview(port).then(({ url }) => {
    console.log(`Предпросмотр Пульта: ${url}/?fx=full`);
    console.log(`Фикстуры: ${FIXTURES.join(', ')} — ?fx=<имя>`);
  });
}
