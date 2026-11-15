/**
 * One FIFO worker for supported Telegram text/voice; forwarded collector reserves
 * its place immediately. Text context → [reply formatter](./reply-context.mjs).
 * [Scheduled turns](../autonomy/legacy-dispatch.mjs) enter as reserved text.
 * Already-prepared introduction recovery stays a separate item; source update
 * IDs of merged text are retained for [Telegram handoff](./bot.mjs).
 * Publish them after the timer file is committed. Retain original timer parts so
 * [worker admission](./bot.mjs) can exclude stale rows without losing user text.
 */
import { buildReplyContext } from './reply-context.mjs';

export const FORWARD_QUIET_MS = 2500;
export const FORWARD_MAX_MS = 25_000;
export const BATCH_MAX_ITEMS = 300;
export const isForwarded = message => Boolean(message?.forward_origin || message?.forward_date || message?.forward_from || message?.forward_from_chat);
const keyOf = item => `${item.ctx.chat.id}:${(item.ctx.message || item.ctx.callbackQuery?.message)?.message_thread_id || 1}`;

// Each queued message owns its quote. Keep raw text separately for the journal.
function textPrompt(item) {
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
  let active, closed = false;
  function effect(fn) {
    const p = Promise.resolve().then(fn).catch(() => onError('[msb/inbox] delivery failed'));
    effects.add(p); p.finally(() => effects.delete(p)); return p;
  }
  function show(entry, text) { effect(() => status(entry, text)); }
  function finishBatch(entry, capHit = false) {
    if (entry.ready || entry.cancelled) return;
    clearTimer(entry.timer); collectors.delete(entry.key);
    entry.ready = true; entry.capHit = capHit;
    if (active || queue[0] !== entry || !canRun()) show(entry, '⏳ в очереди');
    kick();
  }
  function kick() {
    if (closed || active || !canRun() || !queue[0]?.ready) return;
    const entry = queue.shift();
    const occurrences = [];
    // The old worker merges adjacent, already waiting text, never voices/batches/attachments.
    if (!entry.recovered && !entry.items && !entry.voice && !entry.attachment) {
      const parts = [textPart(entry)]; let chars = parts[0].prompt.length;
      while (parts.length < 20) {
        const next = queue[0];
        if (!next?.ready || next.recovered || next.items || next.voice || next.attachment || keyOf(next) !== keyOf(entry)) break;
        const part = textPart(next);
        if (chars + part.prompt.length > 1_000_000) break;
        queue.shift(); chars += part.prompt.length; parts.push(part);
        // Mark the consumed queue status, keeping one thinking/final status.
        next.cancelled = true;
        effect(() => cancel(next, true));
      }
      for (const part of parts) if (part.legacyRun) occurrences.push(occurrenceKey(part.legacyRun));
      if (occurrences.length) entry.legacyParts = parts;
      applyTextParts(entry, parts);
    }
    active = entry;
    effect(async () => {
      try { if (!closed && !entry.cancelled) { entry.started = true; await run(entry); } }
      finally {
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
    push, reserveScheduled, kick, clear,
    isCollecting: ctx => collectors.has(keyOf({ ctx })),
    open() { closed = false; kick(); },
    get size() { return queue.length + Number(Boolean(active)); },
    get hasScheduled() { return Boolean(active?.scheduled || queue.some(item => item.scheduled)); },
    get hasLegacyScheduled() {
      return Boolean(active?.legacyParts || queue.some(item => item.legacyRun?.timer.legacyPendingRun));
    },
    async shutdown() { closed = true; clear(); while (effects.size) await Promise.allSettled([...effects]); },
  };
}
