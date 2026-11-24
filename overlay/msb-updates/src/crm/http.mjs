// HTTP CRM. Вход: cookie сессии и записи клиентов Установщика.
// Выход: HTML. Чужой путь не обрабатывает.
// Токены площадки в страницу не попадают. Проверка: tests/crm.test.mjs.

import { passwordsMatch, createSessionStore } from './session.mjs';
import { publicCard, renderCard, renderList, renderLogin } from './render.mjs';
import { readBody } from '../util.mjs';

function sendHtml(res, status, html, headers = {}) {
  const payload = Buffer.from(html);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readForm(req) {
  const raw = await readBody(req);
  return new URLSearchParams(raw.toString('utf8'));
}

export function createCrm(ctx) {
  const sessions = createSessionStore();
  const secure = String(ctx.config.baseUrl || '').startsWith('https://');

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/crm')) return false;
    if (!ctx.config.crmPassword) {
      sendHtml(res, 404, renderLogin({ error: 'CRM выключена.' }));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/crm/login') {
      const form = await readForm(req);
      if (!passwordsMatch(ctx.config.crmPassword, form.get('password') || '')) {
        sendHtml(res, 401, renderLogin({ error: 'Пароль не подошёл.' }));
        return true;
      }
      const session = sessions.issue();
      res.setHeader('Set-Cookie', sessions.cookie(session.id, { secure }));
      res.writeHead(303, { location: '/crm' });
      res.end();
      return true;
    }
    const session = sessions.get(req);
    if (req.method === 'POST' && url.pathname === '/crm/logout') {
      const form = await readForm(req);
      if (!session || form.get('csrf') !== session.csrf) {
        sendHtml(res, 403, renderLogin({ error: 'Сессия не подтверждена.' }));
        return true;
      }
      sessions.revoke(req);
      res.setHeader('Set-Cookie', sessions.cookie('', { secure, maxAge: 0 }));
      res.writeHead(303, { location: '/crm' });
      res.end();
      return true;
    }
    if (!session) {
      sendHtml(res, 200, renderLogin());
      return true;
    }
    const cardMatch = url.pathname.match(/^\/crm\/installations\/([^/]+)$/);
    if (req.method === 'GET' && cardMatch) {
      const installation = await ctx.clients.getInstallation(decodeURIComponent(cardMatch[1]));
      const card = publicCard(installation);
      if (!card) {
        sendHtml(res, 404, renderLogin({ error: 'Установка не найдена.' }));
        return true;
      }
      sendHtml(res, 200, renderCard({ installation: card, csrf: session.csrf }));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/crm') {
      const installations = (await ctx.clients.listInstallations()).map(publicCard);
      sendHtml(res, 200, renderList({ installations, csrf: session.csrf }));
      return true;
    }
    sendHtml(res, 404, renderLogin({ error: 'Страница не найдена.' }));
    return true;
  }

  return handle;
}
