import fs from 'node:fs';
import { ensureDir, heartbeatPath, botRoot } from './paths.mjs';

/**
 * Маркер живости для puller health-gate / watchdog.
 * Vendor POST heartbeat намеренно не делаем.
 */
export function startHeartbeat({ intervalMs = 60_000, log = console.error } = {}) {
  const write = () => {
    try {
      const file = heartbeatPath();
      ensureDir(botRoot());
      fs.writeFileSync(file, new Date().toISOString());
    } catch (err) {
      log(`[msb/bot] heartbeat write failed: ${err.message}`);
    }
  };
  write();
  const t = setInterval(write, intervalMs);
  t.unref?.();
  return {
    stop() {
      clearInterval(t);
    },
  };
}
