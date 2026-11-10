/**
 * Native Claude --version metadata, never the active provider's PATH shim.
 * [Resolver](../../shared/claude-binary.mjs) → bounded subprocess → fingerprint cache.
 * [Model/effort policy](./models.mjs) and Telegram choices consume this version.
 * No auth/session/config writes. Tests: [cache/resolver](../../tests/claude-version.test.mjs),
 * [production catalog](../../tests/model-catalog.test.mjs). Old SB10525–10648.
 */
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolveNativeClaude, nativeClaudeOverride } from '../../shared/claude-binary.mjs';
async function fingerprint(file) {
  if (!file) return null;
  try { const real = await fs.realpath(file), stat = await fs.stat(real); return [real,stat.mtimeMs,stat.size,stat.ino].join('|'); }
  catch { return null; }
}
async function queryVersion(file, env) {
  if (!file) return 'unknown';
  try {
    const js = /[.](mjs|cjs|js)$/.test(file);
    const stdout = await new Promise((resolve,reject) => {
      const child = execFile(js ? process.execPath : file, js ? [file,'--version'] : ['--version'], {
        env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096, windowsHide: true,
      }, (error,out) => error ? reject(error) : resolve(out));
      child?.stdin?.end();
    });
    const token = stdout.trim().split(/\s+/)[0];
    return /^v?[0-9]+[.][0-9]+[.][0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(token) ? token : 'unknown';
  } catch { return 'unknown'; }
}
export function createClaudeVersionReader({ resolveBin = resolveNativeClaude, fileFingerprint = fingerprint,
  readVersion = queryVersion, now = Date.now, minRereadMs = 15000, maxUnknownRetryMs = 300000 } = {}) {
  let cache = null, inFlight = null, epoch = 0, currentFingerprint;
  const identify = async env => {
    try { const bin = await resolveBin(env); return { bin, fp: await fileFingerprint(bin) }; }
    catch { return { bin: null, fp: null }; }
  };
  return async (env = process.env) => {
    const { bin, fp } = await identify(env), at = now();
    if (fp !== currentFingerprint) { currentFingerprint = fp; epoch++; }
    if (cache) {
      if (fp === null) return cache.version;
      const age = at - cache.readAt;
      if (cache.fp === fp && cache.version !== 'unknown') return cache.version;
      if (cache.fp === fp && age < (cache.retryMs || minRereadMs)) return cache.version;
      if (cache.fp !== fp && age < minRereadMs) return 'unknown';
    }
    if (inFlight?.fp === fp) return inFlight.promise;
    const token = epoch, prior = cache;
    const record = { fp };
    record.promise = Promise.resolve().then(() => readVersion(bin, env)).catch(() => 'unknown').then(async value => {
      const version = typeof value === 'string' && /^v?[0-9]+[.][0-9]+[.][0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(value) ? value : 'unknown';
      if (token !== epoch) return 'unknown';
      const latest = await identify(env);
      if (latest.fp !== fp || token !== epoch) return 'unknown';
      cache = { version, fp, readAt: at };
      if (version === 'unknown' && prior?.fp === fp) cache.retryMs = Math.min((prior.retryMs || minRereadMs) * 2, Math.max(maxUnknownRetryMs,minRereadMs));
      return version;
    }).finally(() => { if (inFlight === record) inFlight = null; });
    inFlight = record;
    return record.promise;
  };
}
// Each runtime profile/override has its own cache; synthetic HOMEs cannot borrow
// metadata from the user's installed CLI or another fixture's native override.
const readers = new Map();
export function readClaudeVersion(env = process.env) {
  const key = [env.HOME,nativeClaudeOverride(env),env.PATH].join('|');
  if (!readers.has(key)) readers.set(key,createClaudeVersionReader());
  return readers.get(key)(env);
}
