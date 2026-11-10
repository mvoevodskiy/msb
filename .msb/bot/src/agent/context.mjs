import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { homeDir } from '../paths.mjs';

/** Native last request size from the session rollout.
 * [Turn](./turn.mjs) can bound the read to one native task for a partial response.
 * [Context checks](../../tests/codex-context.test.mjs).
 */
export async function readSessionContext(sessionId, env = process.env, turnWindow) {
  const match = /^ext:codex:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(sessionId || '');
  if (!match) return null;
  const root = path.join(env.CODEX_HOME || path.join(homeDir(env), '.codex'), 'sessions');
  try {
    const files = (await fs.readdir(root, { recursive: true }))
      .filter((name) => name.endsWith(`-${match[1]}.jsonl`));
    // Never borrow another session's usage or pick an ambiguous transcript.
    if (files.length !== 1) return null;
    const stream = createReadStream(path.join(root, files[0]), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let context = null;
    let model;
    let inTurn = !turnWindow;
    try {
      for await (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (turnWindow) {
          const timestamp = Date.parse(event.timestamp);
          if (!(timestamp >= turnWindow.start && timestamp <= turnWindow.end)) continue;
          if (event.type === 'event_msg' && event.payload?.type === 'task_started') {
            if (inTurn) return null;
            inTurn = true;
          }
          if (!inTurn) continue;
        }
        if (event.type === 'turn_context') model = event.payload?.model;
        // A compaction changes the context. Wait for the next measured count.
        if (event.type === 'compacted' || event.payload?.type === 'context_compacted') context = null;
        if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
        const info = event.payload.info;
        if (!info) continue; // rate-limit-only update
        const used = info.last_token_usage?.total_tokens;
        const limit = info.model_context_window;
        context = Number.isSafeInteger(used) && used >= 0 && Number.isSafeInteger(limit) && limit > 0
          ? { sessionId, model, contextTokens: used, contextWindow: limit, updatedAt: event.timestamp }
          : null;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    return context;
  } catch {
    // Telemetry must not prevent delivery of the model's answer.
    return null;
  }
}

export function contextUsagePercent(context) {
  if (!context || !Number.isSafeInteger(context.contextTokens) || context.contextTokens < 0 ||
      !Number.isSafeInteger(context.contextWindow) || context.contextWindow <= 0) return null;
  return Math.round(context.contextTokens / context.contextWindow * 100);
}

export function formatContextUsage(context) {
  const percent = contextUsagePercent(context);
  if (percent === null) return '';
  const number = (n) => n.toLocaleString('ru-RU');
  return `Контекст: ${percent}% · ${number(context.contextTokens)} / ${number(context.contextWindow)} токенов`;
}
