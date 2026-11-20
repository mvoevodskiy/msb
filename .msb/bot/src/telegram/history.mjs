/** User-facing turn journal consumed by Pult; never reads native conversations.
 * [Bot lifecycle](./bot.mjs) owns the turn; [steer action](./steer-action.mjs)
 * reserves sent corrections on that turn. [Checks](../../tests/steer-history.test.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { botRoot } from '../paths.mjs';

import {historyPreview} from '../history/preview.mjs';
export {historyPreview};

/** Append errors are deliberately isolated from the Telegram response/stop lifecycle. */
export async function beginTurnHistory({ input, env = process.env, now = Date.now, io = fs, log = console.error } = {}) {
  const root = botRoot(env);
  const started = now();
  const turnId = randomUUID();
  const query = historyPreview(input);
  let providerId = null;
  let completed = false;
  let writes = Promise.resolve(), lastAcceptedAt = started;
  const pending = new Set();
  const append = async (relative, row) => {
    try {
      const file = path.join(root, relative);
      await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await io.appendFile(file, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch { try { log('[msb/history] journal write failed'); } catch {} }
  };
  const transcript = (at, row) => append(`transcripts/${at.slice(0, 10)}.jsonl`, { ts: at, turnId, providerId, ...row });
  await transcript(new Date(started).toISOString(), { role: 'user', text: query });
  return {
    // Synchronous reservation fences finish before the physical steer send.
    // Only a confirmed acknowledgement appends a user row to this same turn.
    reserveSteer(input) {
      if (completed) return null;
      const text = historyPreview(input);
      let resolve, settled = false;
      const done = new Promise(r => { resolve = r; });
      pending.add(done);
      done.then(() => pending.delete(done));
      return { settle(status) {
        if (settled) return false;
        settled = true;
        if (status === 'accepted') {
          const at = Math.max(lastAcceptedAt, now());
          lastAcceptedAt = at;
          const ts = new Date(at).toISOString();
          writes = writes.then(() => transcript(ts, { role: 'user', text, providerId: 'codex' }));
          writes.then(resolve, resolve);
        } else resolve();
        return true;
      } };
    },
    provider(value) { if (['claude', 'codex', 'cursor', 'qwen', 'openai'].includes(value)) providerId = value; },
    async finish({ status = 'error', text = '', delivered = false, result } = {}) {
      if (completed) return;
      completed = true;
      if (['claude', 'codex', 'cursor', 'qwen', 'openai'].includes(result?.providerId)) providerId = result.providerId;
      const ended = now();
      await Promise.all([...pending]);
      const ts = new Date(Math.max(ended, lastAcceptedAt)).toISOString();
      const meta = { ts, turnId, providerId, status };
      const trace = { ...meta, query, elapsedMs: Math.max(0, ended - started) };
      // Alternate adapters do not yet report real tool counts. Unknown is not zero.
      if (providerId === 'claude' && Number.isSafeInteger(result?.toolCount) && result.toolCount >= 0) trace.toolCalls = result.toolCount;
      await append(`traces/${ts.slice(0, 10)}.jsonl`, trace);
      await transcript(ts, { role: 'assistant', status, text: delivered ? historyPreview(text) : '' });
      if (delivered && text) await append('chat-diary.jsonl', { ...meta, kind: 'agent_reply', summary: historyPreview(text) });
    },
  };
}
