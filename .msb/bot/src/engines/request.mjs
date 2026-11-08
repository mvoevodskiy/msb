/**
 * Publish one existing helper request without replacing an unconsumed slot.
 * Re-exported by [client](./client.mjs); paths share the selected runtime profile.
 * [Helper consumer](../../../../usr-local-lib/msb-engine/ipc.py) take_request reads then unlinks.
 * No-replace publication also protects that read→unlink interval; the helper is unchanged.
 * [Checks](../../tests/engines-publication.test.mjs), [caller protocol](../../tests/engines-client.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { msbRoot } from '../paths.mjs';

export function engineDir(env = process.env) { return path.join(msbRoot(env), 'engine'); }
export function requestPath(env = process.env) { return path.join(engineDir(env), 'request'); }
export function newRequestId() { return randomBytes(12).toString('hex'); }

/** Success means published, not executed. Busy means this ID was never published. */
export async function submitRequest(action, params = {}, env = process.env, { publishTimeoutMs = 5_000, pollMs = 50, signal } = {}) {
  if (!Number.isFinite(publishTimeoutMs) || publishTimeoutMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new TypeError('Invalid helper publication timeout');
  }
  signal?.throwIfAborted();
  const dir = engineDir(env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const id = newRequestId(), dest = requestPath(env);
  const tmp = path.join(dir, `.request.${id}.tmp`);
  const body = { v: 1, id, action, ...params };
  try {
    await fs.writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    const deadline = performance.now() + publishTimeoutMs;
    while (true) {
      signal?.throwIfAborted();
      try {
        // Same-directory hard link is atomic and refuses an existing destination.
        // Never fall back to rename: that could destroy another published request.
        await fs.link(tmp, dest);
        return { id, path: dest };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw Object.assign(new Error('Предыдущая заявка ещё не принята помощником. Повтори действие позже.'), { code: 'ENGINE_REQUEST_BUSY' });
        }
        await delay(Math.min(pollMs, remaining), undefined, { signal });
      }
    }
  } finally { await fs.unlink(tmp).catch(() => {}); }
}
