/**
 * Локальный обход constructor /api/ssh/* и /api/iia/multibot/*,
 * когда задан MSB_LOCAL_SSH_HOST (или LOCAL_SSH_HOST).
 *
 * Зачем: конструктор SSHит на vps_ip (внешний). На LAN без проброса :22
 * с Railway это не доходит. Локальный IP — операции на этой машине
 * от пользователя client (+ sudo-обёртки), без SSH наружу.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { botEnvPath, globalEnvPath, writeEnvKey } from './env.mjs';
import { msbRoot } from './paths.mjs';
import profile from '../shared/profile.cjs';
import { INPUT_TTL_MS } from '../shared/input-notices.mjs';

const execFileAsync = promisify(execFile);

export const LOCAL_SSH_ENV_KEYS = ['MSB_LOCAL_SSH_HOST', 'IIA_LOCAL_SSH_HOST', 'LOCAL_SSH_HOST'];
export const LOCAL_SSH_PRIMARY_KEY = 'MSB_LOCAL_SSH_HOST';

const pendingLocalIp = new Map(); // userId -> { chatId, messageId? }

export function getLocalSshHost(env = process.env) {
  for (const key of LOCAL_SSH_ENV_KEYS) {
    const v = String(env[key] || '').trim();
    if (v) return v;
  }
  return '';
}

export function isValidIpv4(raw) {
  const s = String(raw || '').trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return false;
  return s.split('.').every((o) => {
    const n = Number(o);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

export function isValidLocalSshHost(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 253) return false;
  if (s === 'localhost') return true;
  // строка из октетов — только как IPv4, не как «hostname»
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return isValidIpv4(s);
  // простой hostname / short DNS
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,251}$/.test(s);
}

export function constructorBaseUrl(env = process.env) {
  const sync = String(env.SYNC_URL || profile.envValue(env, 'MSB_SYNC_URL') || '').trim();
  if (!sync) return '';
  return sync.replace(/\/api\/sync\/?$/, '');
}

export function shouldInterceptConstructorUrl(url, env = process.env) {
  if (!getLocalSshHost(env)) return false;
  const base = constructorBaseUrl(env);
  if (!base) return false;
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  let b;
  try {
    b = new URL(base);
  } catch {
    return false;
  }
  if (u.origin !== b.origin) return false;
  const p = u.pathname;
  return p.startsWith('/api/ssh/') || p.startsWith('/api/iia/multibot/');
}

async function listLocalIps() {
  const out = new Set(['127.0.0.1', '::1', 'localhost']);
  for (const infos of Object.values(os.networkInterfaces() || {})) {
    for (const info of infos || []) {
      if (info?.address) out.add(info.address);
    }
  }
  return out;
}

export async function isLocalTarget(host, env = process.env) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  const locals = await listLocalIps();
  if (locals.has(host) || locals.has(h)) return true;
  // явный флаг «всегда локально»
  if (profile.envValue(env, 'MSB_LOCAL_SSH_FORCE_LOCAL') === '1') return true;
  return false;
}

function authKeysPath(home = os.homedir()) {
  return path.join(home, '.ssh', 'authorized_keys');
}

export function parseAuthorizedKeys(text) {
  const keys = [];
  let index = 1;
  for (const line of String(text || '').split(/\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    const parts = raw.split(/\s+/);
    if (parts.length < 2) continue;
    keys.push({
      index: index++,
      type: parts[0],
      comment: parts.slice(2).join(' ') || '',
      blob: parts[1],
      line: raw,
    });
  }
  return keys;
}

export function parseUfwSshAllowIps(statusText) {
  const ips = [];
  const seen = new Set();
  for (const line of String(statusText || '').split(/\n/)) {
    // «22/tcp ALLOW 1.2.3.4» или «22 ALLOW 1.2.3.4»
    const m = line.match(/^\s*22(?:\/tcp)?\s+ALLOW(?:\s+IN)?\s+(\d{1,3}(?:\.\d{1,3}){3})\b/i);
    if (!m) continue;
    const ip = m[1];
    if (seen.has(ip)) continue;
    seen.add(ip);
    ips.push(ip);
  }
  return ips;
}

async function readKeys(home = os.homedir()) {
  try {
    const text = await fs.readFile(authKeysPath(home), 'utf8');
    return parseAuthorizedKeys(text);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeKeys(keys, home = os.homedir()) {
  const file = authKeysPath(home);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = keys.map((k) => k.line).join('\n') + (keys.length ? '\n' : '');
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, body, { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function keyFingerprint(keyLine) {
  try {
    const { stdout } = await execFileAsync(
      'ssh-keygen',
      ['-lf', '-'],
      { input: `${keyLine}\n`, timeout: 5000, encoding: 'utf8' },
    );
    return String(stdout || '').trim().split(/\n/)[0] || '';
  } catch {
    return '';
  }
}

async function ufwStatus() {
  try {
    const { stdout } = await execFileAsync('sudo', ['-n', 'ufw', 'status'], {
      timeout: 10000,
      encoding: 'utf8',
    });
    return stdout || '';
  } catch (err) {
    return String(err?.stdout || err?.stderr || '');
  }
}

async function listBotIds(home, env = process.env) {
  const dir = path.join(msbRoot(home, env), 'bots');
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => {
      if (a === 'default') return -1;
      if (b === 'default') return 1;
      return a.localeCompare(b);
    });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function botActive(botId) {
  try {
    const { stdout } = await execFileAsync(
      'sudo',
      ['-n', '/usr/local/bin/bot-ctl.sh', 'is-active', botId],
      { timeout: 8000, encoding: 'utf8' },
    );
    return String(stdout || '').trim() === 'active';
  } catch {
    return false;
  }
}

export function isValidBotId(raw) {
  const id = String(raw || '').trim();
  return /^[a-zA-Z0-9_-]{1,32}$/.test(id);
}

export function buildAddTokenFileBody({ botToken, ownerUserId } = {}) {
  const lines = [`BOT_TOKEN=${String(botToken || '').trim()}`];
  const owner = String(ownerUserId || '').trim();
  if (owner) lines.push(`OWNER_USER_ID=${owner}`);
  return `${lines.join('\n')}\n`;
}

async function writeAddTokenFile(botId, body, home, env = process.env) {
  const dir = path.join(msbRoot(home, env), 'tmp');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `add-bot-${botId}.${process.pid}.env`);
  await fs.writeFile(file, body, { mode: 0o600 });
  return file;
}

async function localAddBot({ botId, botToken, ownerUserId, env = process.env, home = env.HOME || os.homedir(), execFile = execFileAsync } = {}) {
  if (!isValidBotId(botId) || botId === 'default' || botId === 'all') {
    const err = new Error(`некорректный botId: ${botId}`);
    err.status = 400;
    throw err;
  }
  const token = String(botToken || '').trim();
  if (token.length < 20) {
    const err = new Error('нужен botToken от BotFather');
    err.status = 400;
    throw err;
  }
  const existing = await listBotIds(home, env);
  if (existing.includes(botId)) {
    const err = new Error(`бот ${botId} уже есть`);
    err.status = 409;
    throw err;
  }
  const tokenFile = await writeAddTokenFile(
    botId,
    buildAddTokenFileBody({ botToken: token, ownerUserId }),
    home,
    env,
  );
  try {
    const { stdout, stderr } = await execFile(
      'sudo',
      ['-n', '/usr/local/bin/bot-ctl.sh', 'add', botId, tokenFile],
      { timeout: 90000, encoding: 'utf8' },
    );
    return { ok: true, botId, detail: String(stdout || stderr || '').trim() };
  } catch (err) {
    try {
      await fs.unlink(tokenFile);
    } catch {
      /* bot-ctl мог уже удалить */
    }
    const msg = String(err?.stderr || err?.stdout || err?.message || err).slice(0, 300);
    const wrapped = new Error(msg);
    wrapped.status = 500;
    throw wrapped;
  }
}

async function localRemoveBot({ botId, env = process.env, home = env.HOME || os.homedir(), execFile = execFileAsync } = {}) {
  if (!isValidBotId(botId) || botId === 'default' || botId === 'all') {
    const err = new Error(`нельзя удалить botId: ${botId}`);
    err.status = 400;
    throw err;
  }
  const existing = await listBotIds(home, env);
  if (!existing.includes(botId)) {
    const err = new Error(`бот ${botId} не найден`);
    err.status = 404;
    throw err;
  }
  try {
    const { stdout, stderr } = await execFile(
      'sudo',
      ['-n', '/usr/local/bin/bot-ctl.sh', 'remove', botId],
      { timeout: 60000, encoding: 'utf8' },
    );
    return { ok: true, botId, detail: String(stdout || stderr || '').trim() };
  } catch (err) {
    const msg = String(err?.stderr || err?.stdout || err?.message || err).slice(0, 300);
    const wrapped = new Error(msg);
    wrapped.status = 500;
    throw wrapped;
  }
}

async function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function handleLocalConstructorRequest(url, init = {}, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || env.HOME || os.homedir();
  const host = getLocalSshHost(env);
  if (!host) {
    return jsonResponse(503, { ok: false, error: `${profile.profileEnvKey(LOCAL_SSH_PRIMARY_KEY, env)} не задан` });
  }

  const u = new URL(String(url));
  const method = String(init.method || 'GET').toUpperCase();
  let body = undefined;
  if (init.body) {
    try {
      body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    } catch {
      body = undefined;
    }
  }

  const local = await isLocalTarget(host, env);
  if (!local) {
    return jsonResponse(501, {
      ok: false,
      error:
        `${profile.profileEnvKey(LOCAL_SSH_PRIMARY_KEY, env)}=${host} не является адресом этой машины. ` +
        'Пока поддерживается только локальный IP/hostname (127.0.0.1, LAN-адрес сервера).',
    });
  }

  try {
    if (u.pathname === '/api/ssh/status' && method === 'GET') {
      const keys = await readKeys(home);
      const ips = parseUfwSshAllowIps(await ufwStatus());
      return jsonResponse(200, {
        ok: true,
        vps_ip: host,
        keys_count: keys.length,
        allowed_ips: ips,
        local_ssh: true,
      });
    }

    if (u.pathname === '/api/ssh/keys' && method === 'GET') {
      const keys = await readKeys(home);
      return jsonResponse(200, {
        keys: keys.map((k) => ({ index: k.index, type: k.type, comment: k.comment })),
      });
    }

    if (u.pathname === '/api/ssh/keys' && method === 'POST') {
      const key = String(body?.key || '').trim();
      if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=]+/.test(key)) {
        return jsonResponse(400, { ok: false, error: 'не похоже на SSH ключ' });
      }
      const keys = await readKeys(home);
      const blob = key.split(/\s+/)[1];
      if (keys.some((k) => k.blob === blob)) {
        return jsonResponse(200, { ok: true, fingerprint: await keyFingerprint(key), dedup: true });
      }
      keys.push({
        index: keys.length + 1,
        type: key.split(/\s+/)[0],
        comment: key.split(/\s+/).slice(2).join(' ') || '',
        blob,
        line: key,
      });
      await writeKeys(keys, home);
      return jsonResponse(200, { ok: true, fingerprint: await keyFingerprint(key) });
    }

    if (u.pathname === '/api/ssh/keys' && method === 'DELETE') {
      const index = Number(body?.index);
      const keys = await readKeys(home);
      const next = keys.filter((k) => k.index !== index);
      if (next.length === keys.length) {
        return jsonResponse(404, { ok: false, error: `ключ #${index} не найден` });
      }
      // перенумеровать
      next.forEach((k, i) => {
        k.index = i + 1;
      });
      await writeKeys(next, home);
      return jsonResponse(200, { ok: true, remaining_keys: next.length });
    }

    if (u.pathname === '/api/ssh/firewall' && method === 'GET') {
      const ips = parseUfwSshAllowIps(await ufwStatus());
      return jsonResponse(200, { rules: ips.map((ip) => ({ ip })) });
    }

    if (u.pathname === '/api/ssh/firewall' && method === 'POST') {
      const ip = String(body?.ip || '').trim();
      if (!isValidIpv4(ip)) return jsonResponse(400, { ok: false, error: 'неверный IP' });
      await execFileAsync('sudo', ['-n', '/usr/local/bin/allow-my-ssh.sh', ip], {
        timeout: 15000,
        encoding: 'utf8',
      });
      return jsonResponse(200, { ok: true });
    }

    if (u.pathname === '/api/ssh/firewall' && method === 'DELETE') {
      const ip = String(body?.ip || '').trim();
      if (!isValidIpv4(ip)) return jsonResponse(400, { ok: false, error: 'неверный IP' });
      await execFileAsync('sudo', ['-n', '/usr/local/bin/remove-my-ssh.sh', ip], {
        timeout: 15000,
        encoding: 'utf8',
      });
      return jsonResponse(200, { ok: true });
    }

    if (u.pathname === '/api/iia/multibot/list' && method === 'GET') {
      const ids = await listBotIds(home, env);
      const bots = [];
      for (const botId of ids) {
        bots.push({ botId, active: await botActive(botId) });
      }
      return jsonResponse(200, { ok: true, bots });
    }

    if (u.pathname === '/api/iia/multibot/add' && method === 'POST') {
      const botId = String(body?.botId || '').trim();
      const botToken = String(body?.botToken || '').trim();
      const ownerUserId = body?.ownerUserId != null ? String(body.ownerUserId).trim() : '';
      try {
        const execFile = opts.execFile || execFileAsync;
        const result = await localAddBot({ botId, botToken, ownerUserId, home, env, execFile });
        return jsonResponse(200, { ok: true, botId: result.botId, local_ssh: true });
      } catch (err) {
        return jsonResponse(err?.status || 500, {
          ok: false,
          error: String(err?.message || err).slice(0, 300),
        });
      }
    }

    if (u.pathname === '/api/iia/multibot/remove' && method === 'POST') {
      const botId = String(body?.botId || '').trim();
      try {
        const execFile = opts.execFile || execFileAsync;
        const result = await localRemoveBot({ botId, home, env, execFile });
        return jsonResponse(200, { ok: true, botId: result.botId, local_ssh: true });
      } catch (err) {
        return jsonResponse(err?.status || 500, {
          ok: false,
          error: String(err?.message || err).slice(0, 300),
        });
      }
    }

    return jsonResponse(404, { ok: false, error: `локально не реализовано: ${method} ${u.pathname}` });
  } catch (err) {
    return jsonResponse(500, { ok: false, error: String(err?.message || err).slice(0, 300) });
  }
}

let fetchPatched = false;
let originalFetch = null;

export function installLocalSshFetchPatch(env = process.env) {
  if (fetchPatched) return;
  fetchPatched = true;
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (url && shouldInterceptConstructorUrl(url, process.env)) {
      return handleLocalConstructorRequest(url, init || {}, { env: process.env });
    }
    return originalFetch(input, init);
  };
  if (getLocalSshHost(env)) {
    console.error(`[msb/ext] local SSH host → ${getLocalSshHost(env)} (constructor /api/ssh + multibot)`);
  }
}

/** Подтянуть MSB_LOCAL_SSH_HOST из файлов .env в process.env (если ещё пусто). */
export async function hydrateLocalSshHost(env = process.env, home = env.HOME || os.homedir()) {
  if (getLocalSshHost(env)) return getLocalSshHost(env);
  for (const file of [botEnvPath(env, home), globalEnvPath(home, env)]) {
    try {
      const text = await fs.readFile(file, 'utf8');
      for (const line of text.split(/\n/)) {
        const m = line.match(/^(MSB_LOCAL_SSH_HOST|IIA_LOCAL_SSH_HOST|LOCAL_SSH_HOST)=(.*)$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (!v) continue;
        profile.setEnvValue(env, m[1], v);
        return v;
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return '';
}

export async function setLocalSshHost(value, env = process.env, home = env.HOME || os.homedir()) {
  const v = String(value || '').trim();
  if (v && !isValidLocalSshHost(v)) {
    throw new Error('Нужен IPv4 или hostname (например 192.168.1.10 или 127.0.0.1)');
  }
  // в per-bot .env — подхватывает EnvironmentFile; в process — сразу
  const key = profile.profileEnvKey(LOCAL_SSH_PRIMARY_KEY, env);
  await writeEnvKey(key, v, env, home);
  // зеркало в глобальный .env (bootstrap-env), без затирания прочих ключей
  await upsertGlobalEnvKey(key, v, home, env);
  profile.setEnvValue(env, key, v || undefined);
  delete env.LOCAL_SSH_HOST;
  return v;
}

async function upsertGlobalEnvKey(key, value, home, env = process.env) {
  const file = globalEnvPath(home, env);
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const lines = text.split(/\n/);
  let hit = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      hit = true;
      return value ? `${key}=${value}` : null;
    }
    // убрать алиас, чтобы не двоилось
    if (line.startsWith('LOCAL_SSH_HOST=')) {
      hit = true;
      return value ? `${key}=${value}` : null;
    }
    return line;
  }).filter((l) => l !== null);
  if (!hit && value) {
    if (next.length && next[next.length - 1] !== '') next.push('');
    next.push(`${key}=${value}`);
  }
  const body = next.join('\n').replace(/\n*$/, '\n');
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, body, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export function setPendingLocalIp(userId, state) {
  pendingLocalIp.set(userId, { ...state, at: Date.now() });
}

/** Origin chat/expiry contract: [text input](./integration/text-input.mjs), [checks](./tests/input-scope.test.mjs). */
export function getPendingLocalIp(userId, { chatId, includeExpired = false } = {}) {
  const s = pendingLocalIp.get(userId);
  if (!s || (chatId !== undefined && Number(s.chatId) !== Number(chatId))) return null;
  if (Date.now() - s.at > INPUT_TTL_MS) {
    if (includeExpired) return { ...s, expired: true };
    pendingLocalIp.delete(userId);
    return null;
  }
  return s;
}

export function clearPendingLocalIp(userId, { chatId } = {}) {
  const row = pendingLocalIp.get(userId);
  if (chatId !== undefined && Number(row?.chatId) !== Number(chatId)) return false;
  return pendingLocalIp.delete(userId);
}
