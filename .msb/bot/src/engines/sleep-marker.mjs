/**
 * Per-bot sleep marker transaction shared by [sleep policy](./sleep.mjs).
 * The caller supplies provider-specific reconciliation and wake recovery;
 * revision-aware wake never removes a newer marker written during a switch.
 * [Checks](../../tests/sleep-marker.test.mjs) cover marker and lock behavior.
 */
import fs from 'node:fs/promises';
import { withFileLock } from '../../shared/file-lock.mjs';

export function createSleepMarker({ marker, onWake = async () => {}, shouldClear = async () => false }) {
  const info = async () => {
    try { return await fs.lstat(marker()); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  };

  async function revision() {
    try {
      const mark = await fs.lstat(marker(), { bigint: true });
      return `${mark.dev}:${mark.ino}:${mark.ctimeNs}`;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function wakeAttempt({ resume = true, expectedRevision } = {}) {
    let outcome = { ok: true };
    try {
      if (expectedRevision !== undefined || await info()) {
        outcome = await withFileLock(marker(), async () => {
          let mark;
          try { mark = await fs.lstat(marker(), { bigint: true }); }
          catch (err) { if (err.code === 'ENOENT') return { ok: true }; throw err; }
          const revision = `${mark.dev}:${mark.ino}:${mark.ctimeNs}`;
          if (expectedRevision !== undefined && expectedRevision !== revision) return { ok: false, stale: true };
          try { await fs.unlink(marker()); }
          catch (err) { if (err.code !== 'ENOENT') return { ok: false, revision }; }
          return { ok: !await info() };
        });
      }
    } catch { return { ok: false }; }
    if (outcome.ok && resume) await onWake().catch(() => {});
    return outcome;
  }

  async function wake(options) { return (await wakeAttempt(options)).ok; }

  async function resumeIfAwake() {
    let awake;
    try { awake = await withFileLock(marker(), async () => !await info()); }
    catch { return false; }
    if (awake) await onWake().catch(() => {});
    return awake;
  }

  async function sleeping({ resumeOnWake = true } = {}) {
    let result;
    try {
      if (!await info()) return false;
      result = await withFileLock(marker(), async () => {
        const mark = await info();
        if (!mark) return { asleep: false, cleared: false };
        if (await shouldClear(mark)) {
          try { await fs.unlink(marker()); }
          catch (err) { if (err.code !== 'ENOENT') return { asleep: true, cleared: false }; }
          return { asleep: Boolean(await info()), cleared: true };
        }
        return { asleep: true, cleared: false };
      });
    } catch { return true; }
    if (result.cleared && resumeOnWake) await onWake().catch(() => {});
    return result.asleep;
  }

  return { wake, wakeAttempt, resumeIfAwake, sleeping, revision };
}
