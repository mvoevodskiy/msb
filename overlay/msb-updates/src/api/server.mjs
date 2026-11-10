import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonBody, sendJson } from '../util.mjs';
import { loadSshInstruction } from '../bot/copy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '../../web/public');

export function createServer(ctx) {
  const { config, auth, releases, intents, worker } = ctx;

  async function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    return auth.resolveBearer(m[1].trim());
  }

  function requireScope(meta, scope) {
    if (!meta || !auth.hasScope(meta, scope)) {
      const err = new Error('forbidden');
      err.status = 403;
      throw err;
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }

      // static web
      if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/web/') || pathname === '/app.js' || pathname === '/app.css')) {
        return serveStatic(res, pathname === '/' ? '/index.html' : pathname.replace(/^\/web/, '') || '/index.html');
      }

      // telegram webhook
      if (req.method === 'POST' && pathname === '/telegram/webhook') {
        if (config.webhookSecret) {
          const got = req.headers['x-telegram-bot-api-secret-token'];
          if (got !== config.webhookSecret) return sendJson(res, 401, { error: 'bad webhook secret' });
        }
        const body = await readJsonBody(req);
        if (ctx.botHandleUpdate) await ctx.botHandleUpdate(body);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname.startsWith('/v1/')) {
        return await handleApi(req, res, url);
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err.status || (err.code === 'BODY_TOO_LARGE' ? 413 : 500);
      sendJson(res, status, { error: err.message || String(err) });
    }
  });

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const meta = await authenticate(req);

    if (req.method === 'GET' && pathname === '/v1/installer/info') {
      // публичная часть для UI без токена не отдаём ключ целиком без auth — но инструкция нужна после login
      if (!meta) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, {
        public_key: worker.getPublicKey(),
        egress_ips: config.egressIps,
        instruction: loadSshInstruction({
          publicKey: worker.getPublicKey(),
          egressIps: config.egressIps,
        }),
        base_url: config.baseUrl,
      });
    }

    if (req.method === 'GET' && pathname === '/v1/me') {
      if (!meta) return sendJson(res, 401, { error: 'unauthorized' });
      const user = await auth.ensureUser(meta.tg_user_id);
      return sendJson(res, 200, {
        tg_user_id: meta.tg_user_id,
        kind: meta.kind,
        scopes: meta.scopes,
        boxes: user.boxes || [],
      });
    }

    if (req.method === 'POST' && pathname === '/v1/auth/web-links') {
      if (!meta) return sendJson(res, 401, { error: 'unauthorized' });
      requireScope(meta, 'web:open');
      const body = await readJsonBody(req);
      const link = await auth.createWebLink({
        tgUserId: body.tg_user_id || meta.tg_user_id,
        ttlSec: body.ttl_sec || 900,
      });
      return sendJson(res, 200, {
        link_id: link.link_id,
        expires_at: link.expires_at,
        url: `${config.baseUrl}/?t=${encodeURIComponent(link.token)}`,
      });
    }

    if (req.method === 'POST' && pathname === '/v1/auth/web-redeem') {
      const body = await readJsonBody(req);
      const issued = await auth.redeemWebLink(body.token || url.searchParams.get('t'));
      if (!issued) return sendJson(res, 401, { error: 'invalid or used link' });
      return sendJson(res, 200, {
        token: issued.token,
        expires_at: issued.meta.expires_at,
        tg_user_id: issued.meta.tg_user_id,
      });
    }

    if (req.method === 'GET' && pathname === '/v1/channels/ext/compatible') {
      if (!meta) return sendJson(res, 401, { error: 'unauthorized' });
      requireScope(meta, 'ext:read');
      const core = url.searchParams.get('core');
      const m = await releases.compatibleExt(core);
      return sendJson(res, 200, { release: m });
    }

    const chMatch = pathname.match(/^\/v1\/channels\/(core|ext)\/(latest|releases)(?:\/([^/]+))?$/);
    if (chMatch && req.method === 'GET') {
      if (!meta) return sendJson(res, 401, { error: 'unauthorized' });
      const channel = chMatch[1];
      requireScope(meta, `${channel}:read`);
      if (chMatch[2] === 'latest') {
        return sendJson(res, 200, { release: await releases.latest(channel) });
      }
      if (chMatch[3]) {
        return sendJson(res, 200, { release: await releases.getRelease(channel, chMatch[3]) });
      }
      return sendJson(res, 200, {
        index: await releases.getIndex(channel),
        releases: await releases.listManifests(channel),
      });
    }

    const assetMatch = pathname.match(/^\/v1\/assets\/([a-f0-9]{64})$/);
    if (assetMatch && req.method === 'GET') {
      if (!meta) return sendJson(res, 401, { error: 'unauthorized' });
      if (!auth.hasScope(meta, 'core:read') && !auth.hasScope(meta, 'ext:read')) {
        return sendJson(res, 403, { error: 'forbidden' });
      }
      const file = releases.openBlob(assetMatch[1]);
      if (!file) return sendJson(res, 404, { error: 'not found' });
      const st = await fsp.stat(file);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': st.size,
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/install/intents') {
      if (!meta) return sendJson(res, 401, { error: 'unauthorized' });
      const body = await readJsonBody(req);
      const type = body.type;
      if (type === 'ext_overlay') requireScope(meta, 'install:ext');
      else if (type === 'empty_bot') requireScope(meta, 'install:empty');
      else return sendJson(res, 400, { error: 'bad type' });

      const rec = await intents.create({
        type,
        tg_user_id: meta.tg_user_id,
        host: body.host || null,
        port: body.port || 22,
        ssh_user: body.ssh_user || config.defaultSshUser,
      });
      if (rec.host) await worker.enqueue(rec.id);
      return sendJson(res, 200, { intent: publicIntent(rec) });
    }

    const intentMatch = pathname.match(/^\/v1\/install\/intents\/([^/]+)(?:\/(retry))?$/);
    if (intentMatch) {
      if (!meta) return sendJson(res, 401, { error: 'unauthorized' });
      const rec = await intents.get(intentMatch[1]);
      if (!rec) return sendJson(res, 404, { error: 'not found' });
      if (rec.tg_user_id !== meta.tg_user_id && meta.kind !== 'admin_publish') {
        return sendJson(res, 403, { error: 'forbidden' });
      }
      if (req.method === 'GET' && !intentMatch[2]) {
        return sendJson(res, 200, { intent: publicIntent(rec) });
      }
      if (req.method === 'POST' && intentMatch[2] === 'retry') {
        const body = await readJsonBody(req);
        if (body.host) rec.host = body.host;
        if (body.port) rec.port = body.port;
        if (body.ssh_user) rec.ssh_user = body.ssh_user;
        rec.error = null;
        await intents.save(rec);
        await worker.enqueue(rec.id);
        return sendJson(res, 200, { intent: publicIntent(await intents.get(rec.id)) });
      }
    }

    if (req.method === 'GET' && pathname === '/v1/install/intents') {
      if (!meta) return sendJson(res, 401, { error: 'unauthorized' });
      const list = await intents.listByUser(meta.tg_user_id);
      return sendJson(res, 200, { intents: list.map(publicIntent) });
    }

    sendJson(res, 404, { error: 'not found' });
  }

  function publicIntent(rec) {
    if (!rec) return null;
    return {
      id: rec.id,
      type: rec.type,
      status: rec.status,
      host: rec.host,
      port: rec.port,
      ssh_user: rec.ssh_user,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      error: rec.error,
      core_version: rec.core_version,
      ext_version: rec.ext_version,
      box_id: rec.box_id,
      log: (rec.log || []).slice(-30),
      result: rec.result && {
        finished_at: rec.result.finished_at,
        dropin: rec.result.dropin,
      },
    };
  }

  async function serveStatic(res, pathname) {
    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(WEB_ROOT, safe);
    if (!file.startsWith(WEB_ROOT)) return sendJson(res, 403, { error: 'forbidden' });
    try {
      const data = await fsp.readFile(file);
      const ext = path.extname(file);
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.md': 'text/plain; charset=utf-8',
      };
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: 'not found' });
    }
  }

  return server;
}
