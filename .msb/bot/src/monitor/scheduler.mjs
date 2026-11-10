import { pollAllSources } from './poll.mjs';
import { maybeSendDigest } from './digest.mjs';

const TICK_MS = 5 * 60 * 1000;
const START_DELAY_MS = 45_000;

/**
 * Фоновый тик мониторинга: poll + дайджест по часу.
 */
export function startMonitorScheduler({ api, adminId, log = console.error } = {}) {
  let stopped = false;
  let busy = false;

  log('[msb/monitor] scheduler start (delay 45s, tick 5m)');
  const boot = setTimeout(tick, START_DELAY_MS);
  const timer = setInterval(tick, TICK_MS);
  boot.unref?.();
  timer.unref?.();

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      await pollAllSources(process.env, { log });
      await maybeSendDigest({ api, adminId, log });
    } catch (err) {
      log(`[msb/monitor] tick error: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  return {
    stop() {
      stopped = true;
      clearTimeout(boot);
      clearInterval(timer);
    },
    tickNow: tick,
  };
}
