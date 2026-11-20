import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertSafeRelPath } from './path-guards.mjs';
import { ensureDir, sha256FileSync } from './util.mjs';

const PRESERVE_PREFIXES = ['bots/', 'workspace/', '.env', 'bots'];

/**
 * Применить манифест в liveDir. blobs: Map sha256 -> absolute path or Buffer getter.
 */
export async function applyManifest({ liveDir, manifest, resolveBlob, rollbackDir = null }) {
  if (!manifest?.files?.length) throw new Error('empty manifest');
  for (const f of manifest.files) {
    const rel = assertSafeRelPath(f.path);
    for (const bad of PRESERVE_PREFIXES) {
      if (rel === bad || rel.startsWith(`${bad}/`) || rel.startsWith('bots/')) {
        throw new Error(`refuse preserve path: ${rel}`);
      }
    }
  }

  const staging = path.join(liveDir, '.msb-updates-staging', `${manifest.channel}-${Date.now()}`);
  await ensureDir(staging);

  try {
    for (const f of manifest.files) {
      const rel = assertSafeRelPath(f.path);
      const blob = await resolveBlob(f.sha256);
      if (!blob) throw new Error(`missing blob ${f.sha256}`);
      const staged = path.join(staging, rel);
      await ensureDir(path.dirname(staged));
      if (Buffer.isBuffer(blob)) await fsp.writeFile(staged, blob);
      else await fsp.copyFile(blob, staged);
      const got = sha256FileSync(staged);
      if (got !== f.sha256) throw new Error(`hash mismatch ${rel}`);
      if (f.mode) await fsp.chmod(staged, parseInt(f.mode, 8));
    }

    if (rollbackDir) {
      await ensureDir(rollbackDir);
      for (const f of manifest.files) {
        const rel = assertSafeRelPath(f.path);
        const live = path.join(liveDir, rel);
        if (fs.existsSync(live)) {
          const bak = path.join(rollbackDir, rel);
          await ensureDir(path.dirname(bak));
          await fsp.copyFile(live, bak);
        }
      }
    }

    for (const f of manifest.files) {
      const rel = assertSafeRelPath(f.path);
      const staged = path.join(staging, rel);
      const live = path.join(liveDir, rel);
      await ensureDir(path.dirname(live));
      await fsp.rename(staged, live);
    }
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }

  return { ok: true, channel: manifest.channel, version: manifest.version, files: manifest.files.length };
}

export async function appendEnvVars(envFile, vars) {
  await ensureDir(path.dirname(envFile));
  let text = '';
  try { text = await fsp.readFile(envFile, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const lines = text ? text.split(/\n/) : [];
  const map = new Map();
  for (const line of lines) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    map.set(line.slice(0, i), line.slice(i + 1));
  }
  for (const [k, v] of Object.entries(vars)) map.set(k, v);
  const out = [...map.entries()].map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const tmp = `${envFile}.tmp`;
  await fsp.writeFile(tmp, out, { mode: 0o600 });
  await fsp.rename(tmp, envFile);
}
