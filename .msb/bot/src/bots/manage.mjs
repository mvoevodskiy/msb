/**
 * Локальное управление multibot через sudo bot-ctl.sh add|remove
 * (без constructor API создателя).
 * Навигация: [Мои боты](./README.md) ← [routes/bots](../telegram/routes/bots.mjs).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { msbRoot, botId as currentBotId } from '../paths.mjs';

const BOT_CTL = process.env.MSB_BOT_CTL || '/usr/local/bin/bot-ctl.sh';

export function botsRoot(env = process.env) {
  return path.join(msbRoot(env), 'bots');
}

export async function listBots(env = process.env) {
  const root = botsRoot(env);
  const me = currentBotId(env);
  let names = [];
  try {
    const ents = await fs.readdir(root, { withFileTypes: true });
    names = ents.filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => /^[a-zA-Z0-9_-]{1,32}$/.test(n));
  } catch {
    names = [me];
  }
  if (!names.includes(me)) names.unshift(me);
  names = [...new Set(names)].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));

  const out = [];
  for (const id of names) {
    const dir = path.join(root, id);
    let active = null;
    try {
      active = await runCtl(['is-active', id]);
      active = active.stdout.trim() === 'active';
    } catch {
      active = null;
    }
    let hasEnv = false;
    try {
      await fs.access(path.join(dir, '.env'));
      hasEnv = true;
    } catch {
      hasEnv = false;
    }
    out.push({ botId: id, active, hasEnv, here: id === me });
  }
  return out;
}

/**
 * @param {string} token BotFather token
 * @param {{ botId?: string, ownerId?: number|string }} [opts]
 */
export async function addBot(token, opts = {}, env = process.env) {
  const tok = String(token || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(tok)) {
    return { ok: false, error: 'Токен не похож на BotFather (вид: 123456:ABC…).' };
  }
  let id = (opts.botId || '').trim();
  if (!id) {
    // username из getMe — если сеть есть; иначе numeric prefix
    try {
      const me = await fetch(`https://api.telegram.org/bot${tok}/getMe`, {
        signal: AbortSignal.timeout(15000),
      }).then((r) => r.json());
      if (me?.ok && me.result?.username) {
        id = String(me.result.username).replace(/_bot$/i, '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
      }
    } catch {
      /* fallback */
    }
  }
  if (!id) id = `bot${tok.split(':')[0].slice(-6)}`;
  if (id === 'default' || id === 'all') {
    return { ok: false, error: 'id default/all зарезервированы' };
  }

  const tmp = path.join(os.tmpdir(), `msb-add-${id}-${process.pid}.env`);
  const lines = [`BOT_TOKEN=${tok}`];
  const owner = opts.ownerId || env.ADMIN_ID || env.OWNER_USER_ID;
  if (owner) lines.push(`OWNER_USER_ID=${owner}`);
  await fs.writeFile(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });

  try {
    const res = await runCtl(['add', id, tmp], { timeoutMs: 120_000 });
    if (res.code !== 0) {
      return { ok: false, error: (res.stderr || res.stdout || `exit ${res.code}`).slice(0, 400), botId: id };
    }
    return { ok: true, botId: id, detail: res.stdout.trim() };
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, error: err.message, botId: id };
  }
}

export async function removeBot(id, env = process.env) {
  if (!id || id === 'default' || id === currentBotId(env)) {
    return { ok: false, error: 'Нельзя удалить default или текущий бот из его же чата.' };
  }
  try {
    const res = await runCtl(['remove', id], { timeoutMs: 60_000 });
    if (res.code !== 0) {
      return { ok: false, error: (res.stderr || res.stdout || `exit ${res.code}`).slice(0, 400) };
    }
    return { ok: true, detail: res.stdout.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function runCtl(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', BOT_CTL, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error(`bot-ctl timeout (${args[0]})`));
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
