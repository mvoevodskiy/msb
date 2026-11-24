/**
 * Daytime reminder for a local owner's STOP. The [dispatcher](./reminder-dispatch.mjs)
 * checks it once per pass. The [pause lock](./owner-pause.mjs) serializes receipt,
 * delivery and resume. [Scheduler tests](../../tests/pause-reminder-notice.test.mjs).
 */
import path from 'node:path';
import { actionRoot } from '../paths.mjs';
import { loadState } from '../state.mjs';
import { singleRequestSignal } from '../telegram/presentation-api.mjs';
import { isNoticeMuted, noticeMuteKeyboard } from '../notification-mutes.mjs';
import { withAutonomyPauseLock } from './owner-pause.mjs';
import { formatPauseNotice, PAUSE_OFF_BUTTON, readPauseNoticeSnapshot } from './pause-notice-text.mjs';
import { readOptionalJson, writeRecordJson } from './record-file.mjs';
import { readReminderPolicy, reminderOwnerChat } from './reminder-policy.mjs';

const DAY = 86_400_000;
function localHour(at, timezone) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', hourCycle: 'h23', timeZone: timezone || 'UTC',
    }).format(at));
  } catch {
    return new Date(at).getUTCHours();
  }
}

export async function sendStalePauseNotice({ api, chat, adminId, now, timezone, signal, isStopped }) {
  return withAutonomyPauseLock(async () => {
    if (isStopped()) return;
    const { state } = await loadState();
    const zone = state.timezone || timezone;
    const at = now(), hour = localHour(at, zone);
    if (hour < 9 || hour >= 21 || reminderOwnerChat(state, adminId) !== chat) return;
    const file = path.join(actionRoot(), 'autonomy', 'stop-notice.json');
    // This receipt is derived delivery state. A torn JSON write from an older
    // runtime cannot prove a recent send. Real filesystem errors still abort.
    const receipt = await readOptionalJson(file).catch(error => {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    });
    if (at - Date.parse(receipt?.lastToldAt) < 7 * DAY) return;
    const policy = await readReminderPolicy(state);
    if (!policy.enabled || !policy.local || !policy.ownerStopped || policy.asleep) return;
    const snapshot = await readPauseNoticeSnapshot();
    if (!snapshot || !snapshot.tasks || at - snapshot.since <= DAY) return;
    const muted = await isNoticeMuted('pause_reminder');
    if (isStopped()) return;
    if (!muted) {
      const timeout = AbortSignal.timeout(15_000);
      const request = singleRequestSignal(signal ? AbortSignal.any([timeout, signal]) : timeout);
      await api.sendMessage(chat, formatPauseNotice({ ...snapshot, now: at, timezone: zone }), {
        reply_markup: noticeMuteKeyboard('pause_reminder', [[PAUSE_OFF_BUTTON]]),
      }, request);
    }
    // The old scheduler also remembered an intentionally muted occurrence.
    // A Telegram failure throws before this write so the next pass may retry.
    const previous = receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : {};
    await writeRecordJson(file, { ...previous, lastToldAt: new Date(at).toISOString() }, { create: true });
  });
}
