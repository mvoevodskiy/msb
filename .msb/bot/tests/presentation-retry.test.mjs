import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { presentationAwareRetry } from '../src/telegram/presentation-api.mjs';
import { startTurnProgress } from '../src/telegram/progress.mjs';
import { deliverTurnResponse } from '../src/telegram/response.mjs';

const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const rateLimit = (seconds = 120) => ({ ok: false, error_code: 429, description: 'Too Many Requests: fixture', parameters: { retry_after: seconds } });
const success = (payload = {}) => ({ ok: true, result: { message_id: 101, date: 1, chat: { id: 42, type: 'private' }, ...payload } });
function watch(promise) {
  const result = { settled: false };
  result.promise = promise.then(value => { result.settled = true; result.value = value; }, error => { result.settled = true; result.error = error; });
  return result;
}

// Drive real autoRetry timers without waiting for a real 120-second flood delay.
// API transport timeouts and progress intervals use this same deterministic clock.
function fakeClock() {
  let now = 0, nextId = 0;
  const tasks = new Map();
  const original = { setTimeout, clearTimeout, setInterval, clearInterval };
  const schedule = (fn, delay, interval, args) => {
    const handle = { id: ++nextId, unref() { return this; } };
    tasks.set(handle, { fn, at: now + delay, delay, interval, args });
    return handle;
  };
  const timers = {
    setTimeout: (fn, delay, ...args) => schedule(fn, delay, false, args),
    clearTimeout: handle => tasks.delete(handle),
    setInterval: (fn, delay, ...args) => schedule(fn, delay, true, args),
    clearInterval: handle => tasks.delete(handle),
  };
  Object.assign(globalThis, timers);
  return {
    timers, tasks, now: () => now,
    hasDelay: delay => [...tasks.values()].some(task => !task.interval && task.delay === delay),
    async advance(to) {
      await flush();
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [handle, task] = next;
        now = task.at;
        if (task.interval) task.at += task.delay;
        else tasks.delete(handle);
        task.fn(...task.args);
        await flush();
      }
      now = to;
      await flush();
    },
    restore() { tasks.clear(); Object.assign(globalThis, original); },
  };
}

function fixture(respond) {
  const calls = [], applied = [];
  const api = new Api('42:presentation-fixture-only', {
    apiRoot: 'https://telegram.fixture.invalid',
    fetch: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://telegram.fixture.invalid');
      const method = new URL(url).pathname.split('/').at(-1);
      const payload = JSON.parse(options.body);
      const call = { method, payload, signal: options.signal };
      calls.push(call);
      // Deliberately allow a response to arrive after cancellation: this models
      // the race between a completed HTTP response and autoRetry's pause().
      const result = await respond(call, calls);
      if (result.ok && ['sendMessage', 'editMessageText'].includes(method)) applied.push(call);
      return { json: async () => result };
    },
  });
  const retry = autoRetry();
  // Optional proof: the same assertions are RED with unwrapped autoRetry 2.0.2.
  api.config.use(process.env.MSB_PRESENTATION_LEGACY_RETRY === '1' ? retry : presentationAwareRetry(retry));
  const ctx = {
    api, chat: { id: 42 }, message: { message_id: 501, message_thread_id: 7 },
    reply: (text, options) => api.sendMessage(42, text, options),
  };
  return { ctx, calls, applied };
}

test('presentation retry: progress 429 starts a cooldown instead of holding completion in autoRetry', async () => {
  for (const method of ['editMessageText', 'sendChatAction']) {
    const clock = fakeClock();
    let progress, failed = false;
    const f = fixture(call => {
      if (call.method === method && !failed) { failed = true; return rateLimit(); }
      return success(call.payload);
    });
    try {
      progress = startTurnProgress(f.ctx, 101, { now: clock.now, timers: clock.timers });
      await flush();
      assert.equal(failed, true);
      assert.equal(clock.hasDelay(120_000), false, 'A best-effort request must not create an autoRetry pause.');
      const count = f.calls.length;
      await clock.advance(119_999);
      assert.equal(f.calls.length, count, 'Both animation and typing must respect retry_after.');
      await clock.advance(120_000);
      assert.ok(f.calls.length > count, 'Presentation may resume when the flood cooldown expires.');
      const stop = watch(progress.stop());
      await flush();
      assert.equal(stop.settled, true, 'Final delivery must not wait for obsolete animation retries.');
      assert.equal(stop.error, undefined);
      assert.equal(clock.tasks.size, 0);
    } finally {
      const stop = progress?.stop();
      await clock.advance(clock.now() + 120_000);
      await stop;
      clock.restore();
    }
  }
});

test('presentation retry: stop drains late HTTP results without a retry or final overwrite', async () => {
  for (const lateResult of ['429', 'success']) {
    const clock = fakeClock(), held = gate();
    let progress, finishing, firstEdit = true;
    const f = fixture(async call => {
      if (call.method === 'editMessageText' && firstEdit) {
        firstEdit = false;
        await held.promise;
        return lateResult === '429' ? rateLimit() : success(call.payload);
      }
      return success(call.payload);
    });
    try {
      progress = startTurnProgress(f.ctx, 101, { now: clock.now, timers: clock.timers });
      await flush();
      const pendingEdit = f.calls.find(call => call.method === 'editMessageText');
      assert.ok(pendingEdit);
      finishing = watch((async () => {
        await progress.stop();
        return deliverTurnResponse(f.ctx, 101, 'Финальный ответ', { elapsedMs: 13_000 });
      })());
      await flush();
      assert.equal(pendingEdit.signal.aborted, false, 'An accepted edit must drain before retiring its transport signal.');
      assert.equal(finishing.settled, false, 'Do not release final delivery while an accepted edit can still arrive.');
      assert.ok(!f.calls.some(call => call.payload.text?.startsWith('Финальный ответ')));
      held.resolve();
      await flush();
      assert.equal(clock.hasDelay(120_000), false, 'A late 429 must not enter an obsolete autoRetry pause.');
      assert.equal(finishing.settled, true);
      assert.equal(finishing.error, undefined);
      assert.deepEqual(finishing.value, { method: 'edit', messages: 1 });
      assert.equal(f.applied.at(-1).payload.text, 'Финальный ответ\n\n<blockquote>⏱ 13.0s</blockquote>');
      const count = f.calls.length;
      await clock.advance(120_000);
      assert.equal(f.calls.length, count, 'An old request must never retry over the completed answer.');
      assert.equal(clock.tasks.size, 0);
    } finally {
      held.resolve();
      const stop = progress?.stop();
      await clock.advance(clock.now() + 120_000);
      await stop;
      await finishing?.promise;
      clock.restore();
    }
  }
});

test('presentation retry: final edit and cleanup 429 fall back immediately, while the actual answer send retains autoRetry', async () => {
  const clock = fakeClock();
  let sends = 0, delivery;
  const f = fixture(call => {
    if (call.method === 'editMessageText' || call.method === 'deleteMessage') return rateLimit();
    if (call.method === 'sendMessage' && ++sends === 1) return rateLimit(2);
    return success(call.payload);
  });
  try {
    delivery = watch(deliverTurnResponse(f.ctx, 101, 'Финальный ответ', { elapsedMs: 13_000 }));
    await flush();
    assert.deepEqual(f.calls.map(call => call.method), ['editMessageText', 'deleteMessage', 'sendMessage']);
    assert.equal(clock.hasDelay(120_000), false, 'Neither failed final edit nor cleanup may delay the send fallback.');
    assert.equal(clock.hasDelay(2000), true, 'Ordinary answer sends must keep the original retry behavior.');
    assert.equal(delivery.settled, false);
    await clock.advance(1999);
    assert.equal(sends, 1);
    await clock.advance(2000);
    assert.equal(sends, 2);
    assert.equal(delivery.settled, true);
    assert.equal(delivery.error, undefined);
    assert.deepEqual(delivery.value, { method: 'send', messages: 1 });
    assert.equal(f.applied.length, 1);
    assert.equal(f.applied[0].payload.text, 'Финальный ответ\n\n<blockquote>⏱ 13.0s</blockquote>');
    assert.equal(f.applied[0].payload.message_thread_id, 7);
    assert.deepEqual(f.calls.filter(call => call.method === 'deleteMessage').map(call => call.payload.message_id), [101]);
    assert.equal(clock.tasks.size, 0);
  } finally {
    // Bound a legacy run too: abort-aware current presentation signals stop its
    // edit; any plain cleanup pause is driven by the fake clock, never wall time.
    await clock.advance(clock.now() + 240_002);
    clock.restore();
  }
});

test('presentation retry: client abort must not release a final edit ahead of an accepted remote animation', async () => {
  const held = gate();
  let first = true, remoteText = '', remoteApply, progress, finishing;
  const f = fixture(call => {
    if (call.method === 'editMessageText' && first) {
      first = false;
      // Telegram has accepted the request. Cancelling the client fetch does not
      // roll back server work, whose application is independent of its response.
      remoteApply = held.promise.then(() => { remoteText = call.payload.text; return success(call.payload); });
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Client disconnected', 'AbortError'));
        call.signal.addEventListener('abort', abort, { once: true });
        if (call.signal.aborted) abort();
        remoteApply.then(resolve).finally(() => call.signal.removeEventListener('abort', abort));
      });
    }
    if (call.method === 'editMessageText') remoteText = call.payload.text;
    return success(call.payload);
  });
  try {
    progress = startTurnProgress(f.ctx, 101);
    await flush(); assert.ok(remoteApply, 'Exercise an already accepted remote edit.');
    finishing = watch((async () => {
      await progress.stop();
      return deliverTurnResponse(f.ctx, 101, 'Моя остановочка ✋🏽⛔️');
    })());
    await flush();
    held.resolve(); await remoteApply; await flush(); await finishing.promise;
    assert.equal(finishing.error, undefined);
    assert.equal(remoteText, 'Моя остановочка ✋🏽⛔️', 'A server-side animation must never overwrite the terminal stop.');
  } finally { held.resolve(); await progress?.stop(); await finishing?.promise; }
});
