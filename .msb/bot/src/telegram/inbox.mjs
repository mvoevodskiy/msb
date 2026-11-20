/**
 * One FIFO worker for supported Telegram text/voice; forwarded collector reserves
 * its place immediately. Text context → [reply formatter](./reply-context.mjs).
 * [Scheduled turns](../autonomy/legacy-dispatch.mjs) enter as reserved text.
 * Already-prepared introduction recovery stays a separate item; source update
 * IDs of merged text are retained for [Telegram handoff](./bot.mjs).
 * Publish them after the timer file is committed. Retain original timer parts so
 * [worker admission](./bot.mjs) can exclude stale rows without losing user text.
 * Text merges only with a confirmed head receipt. If it is still pending,
 * the head registers as a single turn so [reply stop](../../tests/inbox-lifecycle.test.mjs)
 * can reach it. Other entries stay in [FIFO](../../tests/legacy-timer-dispatch.test.mjs).
 * Queued correction reservations and cancellation: [steering contract](../../tests/reference/codex-steer-contract.txt)
 * and [reservation checks](../../tests/steer-inbox.test.mjs).
 */
import { randomBytes } from 'node:crypto';
import { buildReplyContext } from './reply-context.mjs';

export const FORWARD_QUIET_MS = 2500;
export const FORWARD_MAX_MS = 25_000;
export const BATCH_MAX_ITEMS = 300;
export const isForwarded = message => Boolean(message?.forward_origin || message?.forward_date || message?.forward_from || message?.forward_from_chat);
const keyOf = item => `${item.ctx.chat.id}:${(item.ctx.message || item.ctx.callbackQuery?.message)?.message_thread_id || 1}`;
const isReadyText = item => item?.ready && !item.recovered && !item.items && !item.voice && !item.attachment;

// Each queued message owns its quote. Keep raw text separately for the journal.
export function textPrompt(item) {
  const referent = buildReplyContext(item.ctx.message, item.ctx.me?.id);
  return referent ? `${referent}\n\n${item.text}` : item.text;
}
function mergeTexts(texts) {
  return texts.length === 1 ? texts[0] :
    `Пока шёл предыдущий ход, пользователь отправил ещё ${texts.length} сообщений. Обработай их ВМЕСТЕ, одним ответом — не по одному.\n\n` +
    texts.map((text, i) => `[Сообщение ${i + 1}/${texts.length}]\n${text}`).join('\n\n');
}

function textPart(entry) {
  return { ctx: entry.ctx, text: entry.text, prompt: textPrompt(entry), scheduled: entry.scheduled,
    legacyRun: entry.legacyRun };
}

function applyTextParts(entry, parts) {
  entry.ctx = parts[0].ctx;
  entry.text = mergeTexts(parts.map(part => part.text));
  entry.prompt = mergeTexts(parts.map(part => part.prompt));
  entry.sourceUpdateIds = parts.map(part => part.ctx.update?.update_id).filter(Number.isSafeInteger);
  entry.scheduled = parts.some(part => part.scheduled);
  if (entry.scheduled) entry.isAutoTurn = parts.every(part => part.scheduled);
  else delete entry.isAutoTurn;
}

export function retainAdmittedTimerParts(entry, admitted) {
  const parts = entry.legacyParts.filter(part => !part.legacyRun || admitted.has(part.legacyRun));
  if (!parts.length) return false;
  if (parts.length !== entry.legacyParts.length) applyTextParts(entry, parts);
  return true;
}

function occurrenceKey(legacyRun) {
  return JSON.stringify([legacyRun.file, legacyRun.id]);
}

export function createInbox({ run, status, cancel, canRun = () => true, onError = console.error,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const queue = [], collectors = new Map(), effects = new Set(), scheduledOccurrences = new Set();
  const confirmedQueueReceipts = new WeakSet();
  let active, closed = false, steerReservation;
  const steerTokens = new WeakMap();
  function eligible(item) {
    return Boolean(item.ctx?.message && !item.scheduled && !item.legacyRun && !item.recovered &&
      !item.items && !item.attachment && !item.isAutoTurn && !isForwarded(item.ctx.message) &&
      (item.voice === true || (item.voice === false && typeof item.text === 'string')));
  }
  function tokenFor(item) {
    let token = steerTokens.get(item);
    if (!token) {
      token = randomBytes(12).toString('base64url');
      steerTokens.set(item, token);
    }
    return token;
  }
  /**
   * Tokens identify individual queued user text/voice entries, not message contents.
   * Candidates are snapshots { token, entry }; status IDs may appear asynchronously.
   * reserveForSteer requires exact token, numeric chatId, topic (1 for main), and
   * bot status messageId. Failure or an existing reservation returns null.
   * A handle's consume/release/unknown return true once, false after invalidation.
   * consume removes only that entry; release retains its place; both wake FIFO.
   * unknown fences the whole FIFO until clear/shutdown. All terminal methods abort
   * the signal; clear/shutdown also invalidate and abort an outstanding handle.
   */
  function steerCandidates() {
    if (closed || steerReservation) return [];
    return steerEntries();
  }
  // Rendering also needs to retire buttons while another entry is reserved.
  function steerEntries() {
    if (closed) return [];
    return queue.filter(item => item.ready && !item.cancelled && eligible(item))
      .map(entry => ({ token: tokenFor(entry), entry }));
  }
  function reserveForSteer({ token, chatId, threadId, messageId }) {
    if (closed || steerReservation || !Number.isSafeInteger(chatId) ||
        !Number.isSafeInteger(threadId) || !Number.isSafeInteger(messageId)) return null;
    const entry = queue.find(item => item.ready && !item.cancelled && eligible(item) &&
      steerTokens.get(item) === token && item.ctx.chat?.id === chatId &&
      ((item.ctx.message || item.ctx.callbackQuery?.message)?.message_thread_id || 1) === threadId &&
      item.status?.message_id === messageId);
    if (!entry) return null;
    const reservation = { entry, controller: new AbortController(), state: 'reserved' };
    steerReservation = reservation;
    const isCurrent = () => !closed && steerReservation === reservation &&
      reservation.state === 'reserved' && !entry.cancelled && queue.includes(entry);
    function finish(state) {
      if (!isCurrent()) return false;
      reservation.state = state;
      if (state === 'consumed') queue.splice(queue.indexOf(entry), 1);
      if (state !== 'unknown') steerReservation = undefined;
      reservation.controller.abort();
      if (state !== 'unknown') kick();
      return true;
    }
    return { entry, signal: reservation.controller.signal, isCurrent,
      consume: () => finish('consumed'), release: () => finish('released'), unknown: () => finish('unknown') };
  }
  function effect(fn) {
    const p = Promise.resolve().then(fn).catch(() => onError('[msb/inbox] delivery failed'));
    effects.add(p); p.finally(() => effects.delete(p)); return p;
  }
  function show(entry, text) {
    effect(async () => {
      await status(entry, text);
      if (text === '⏳ в очереди') confirmedQueueReceipts.add(entry);
    });
  }
  function finishBatch(entry, capHit = false) {
    if (entry.ready || entry.cancelled) return;
    clearTimer(entry.timer); collectors.delete(entry.key);
    entry.ready = true; entry.capHit = capHit;
    if (active || queue[0] !== entry || !canRun()) show(entry, '⏳ в очереди');
    kick();
  }
  function kick() {
    if (closed || active || steerReservation || !canRun() || !queue[0]?.ready) return;
    const entry = queue.shift();
    const occurrences = entry.legacyRun ? [occurrenceKey(entry.legacyRun)] : [];
    const possibleTail = isReadyText(entry) && isReadyText(queue[0]) && keyOf(queue[0]) === keyOf(entry)
      ? queue.slice(0, 19) : [];
    active = entry;
    effect(async () => {
      try {
        if (closed || entry.cancelled) return;
        if (isReadyText(entry)) {
          const merge = confirmedQueueReceipts.has(entry);
          const parts = [textPart(entry)];
          let chars = parts[0].prompt.length;
          // Consume neighbors only after the first entry has a usable queue status.
          for (const next of merge ? possibleTail : []) {
            if (queue[0] !== next || !isReadyText(next) || keyOf(next) !== keyOf(entry)) break;
            const part = textPart(next);
            if (chars + part.prompt.length > 1_000_000) break;
            queue.shift(); chars += part.prompt.length; parts.push(part);
            if (next.legacyRun) occurrences.push(occurrenceKey(next.legacyRun));
            next.cancelled = true;
            effect(() => cancel(next, true));
          }
          if (parts.length > 1) entry.mergedText = true;
          if (occurrences.length) entry.legacyParts = parts;
          applyTextParts(entry, parts);
        }
        entry.started = true;
        await run(entry);
      } finally {
        for (const occurrence of occurrences) scheduledOccurrences.delete(occurrence);
        active = undefined;
        kick();
      }
    });
  }
  function push(item) {
    if (closed) return;
    const key = keyOf(item), forwarded = !item.recovered && isForwarded(item.ctx.message);
    let batch = item.recovered ? undefined : collectors.get(key);
    if (forwarded || batch) {
      if (!batch) {
        batch = { ctx: item.ctx, key, items: [], startedAt: now(), ready: false };
        collectors.set(key, batch); queue.push(batch);
      }
      batch.items.push({ ...item, comment: !forwarded });
      show(batch, batch.items.length === 1 ? '📥 Собираю пересланное…' : `📥 Собираю пересланное… (${batch.items.length})`);
      clearTimer(batch.timer);
      if (batch.items.length >= BATCH_MAX_ITEMS) finishBatch(batch, true);
      else {
        batch.timer = setTimer(() => finishBatch(batch), Math.max(0, Math.min(FORWARD_QUIET_MS, FORWARD_MAX_MS - (now() - batch.startedAt))));
        batch.timer.unref?.();
      }
    } else {
      item.ready = true;
      if (active || queue.length || !canRun()) show(item, '⏳ в очереди');
      queue.push(item); kick();
    }
  }
  function reserveScheduled(item) {
    if (closed) return null;
    const occurrence = item.legacyRun && occurrenceKey(item.legacyRun);
    if (occurrence && scheduledOccurrences.has(occurrence)) return null;
    if (occurrence) scheduledOccurrences.add(occurrence);
    item.ready = false;
    item.scheduled = true;
    queue.push(item);
    return committed => {
      const index = queue.indexOf(item);
      if (index < 0 || item.ready) return;
      if (committed) {
        item.ready = true;
        if (active || queue[0] !== item || !canRun()) show(item, '⏳ в очереди');
      } else {
        item.cancelled = true;
        queue.splice(index, 1);
        if (occurrence) scheduledOccurrences.delete(occurrence);
      }
      kick();
    };
  }
  function clear() {
    if (steerReservation) {
      const reservation = steerReservation;
      steerReservation = undefined;
      reservation.controller.abort();
    }
    const hadPending = queue.length > 0 || Boolean(active && !active.started);
    if (active && !active.started) { active.cancelled = true; effect(() => cancel(active)); }
    for (const entry of queue.splice(0)) {
      entry.cancelled = true; clearTimer(entry.timer);
      if (entry.legacyRun) scheduledOccurrences.delete(occurrenceKey(entry.legacyRun));
      effect(() => cancel(entry));
    }
    collectors.clear(); return hadPending;
  }
  return {
    push, reserveScheduled, kick, clear, steerCandidates, steerEntries, reserveForSteer,
    isCollecting: ctx => collectors.has(keyOf({ ctx })),
    open() { closed = false; kick(); },
    get size() { return queue.length + Number(Boolean(active)); },
    get steerBusy() { return Boolean(steerReservation); },
    get hasScheduled() { return Boolean(active?.scheduled || queue.some(item => item.scheduled)); },
    get hasLegacyScheduled() {
      return Boolean(active?.legacyRun || active?.legacyParts || queue.some(item => item.legacyRun?.timer.legacyPendingRun));
    },
    async shutdown() { closed = true; clear(); while (effects.size) await Promise.allSettled([...effects]); },
  };
}
