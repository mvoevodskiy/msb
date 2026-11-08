/**
 * One FIFO worker for supported Telegram text/voice; forwarded collector reserves
 * its place immediately. Text context → [reply formatter](./reply-context.mjs).
 * No provider/session state here. See README.md#очередь.
 */
import { buildReplyContext } from './reply-context.mjs';

export const FORWARD_QUIET_MS = 2500;
export const FORWARD_MAX_MS = 25_000;
export const BATCH_MAX_ITEMS = 300;
export const isForwarded = message => Boolean(message?.forward_origin || message?.forward_date || message?.forward_from || message?.forward_from_chat);
const keyOf = item => `${item.ctx.chat.id}:${item.ctx.message?.message_thread_id || 1}`;

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

export function createInbox({ run, status, cancel, canRun = () => true, onError = console.error,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const queue = [], collectors = new Map(), effects = new Set();
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
    // The old worker merges adjacent, already waiting text, never voices/batches.
    if (!entry.items && !entry.voice) {
      const texts = [entry.text], prompts = [textPrompt(entry)]; let chars = prompts[0].length;
      while (texts.length < 20) {
        const next = queue[0];
        if (!next?.ready || next.items || next.voice || keyOf(next) !== keyOf(entry)) break;
        const prompt = textPrompt(next);
        if (chars + prompt.length > 1_000_000) break;
        queue.shift(); chars += prompt.length; texts.push(next.text); prompts.push(prompt);
        // Mark the consumed queue status, keeping one thinking/final status.
        next.cancelled = true;
        effect(() => cancel(next, true));
      }
      entry.text = mergeTexts(texts);
      entry.prompt = mergeTexts(prompts);
    }
    active = entry;
    effect(async () => {
      try { if (!closed && !entry.cancelled) { entry.started = true; await run(entry); } }
      finally { active = undefined; kick(); }
    });
  }
  function push(item) {
    if (closed) return;
    const key = keyOf(item), forwarded = isForwarded(item.ctx.message);
    let batch = collectors.get(key);
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
  function clear() {
    const hadPending = queue.length > 0 || Boolean(active && !active.started);
    if (active && !active.started) { active.cancelled = true; effect(() => cancel(active)); }
    for (const entry of queue.splice(0)) {
      entry.cancelled = true; clearTimer(entry.timer);
      effect(() => cancel(entry));
    }
    collectors.clear(); return hadPending;
  }
  return {
    push, kick, clear,
    isCollecting: ctx => collectors.has(keyOf({ ctx })),
    open() { closed = false; kick(); },
    get size() { return queue.length + Number(Boolean(active)); },
    async shutdown() { closed = true; clear(); while (effects.size) await Promise.allSettled([...effects]); },
  };
}
