/**
 * Pre-claim freshness for legacy saved prompts. [Policy](./prompt-policy.mjs)
 * admits `task.freshness`; [runner](./prompt-turn.mjs) refuses before spawn when
 * a watched path is missing or older than `maxAgeHours`. Quiet markers must not
 * hide a stale source.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function expandPath(value, env = process.env) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return env.HOME || os.homedir();
  if (raw.startsWith('~/')) return path.join(env.HOME || os.homedir(), raw.slice(2));
  return raw;
}

export async function checkSavedPromptFreshness(action, { now = Date.now(), env = process.env } = {}) {
  const freshness = action?.task?.freshness;
  const paths = Array.isArray(freshness?.paths) ? freshness.paths.filter(value => typeof value === 'string' && value.trim()) : [];
  if (!paths.length) return { ok: true };
  const maxAgeHours = Number(freshness.maxAgeHours);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return { ok: true };
  const maxAgeMs = maxAgeHours * 3_600_000;
  for (const entry of paths) {
    const file = path.resolve(expandPath(entry, env));
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return { ok: false, path: file, reason: 'missing' };
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      return { ok: false, path: file, reason: 'missing' };
    }
    if ((now - stat.mtimeMs) > maxAgeMs) {
      return { ok: false, path: file, reason: 'stale', ageHours: (now - stat.mtimeMs) / 3_600_000 };
    }
  }
  return { ok: true };
}
