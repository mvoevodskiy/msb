// Входящие сообщения бота уведомлений Пульта: только владелец (PULT_TG_CHAT_ID).
// Чужим — тишина. Владельцу на любое сообщение — свежая кнопка Mini App (через callback).

import type { Config } from './config.ts';
import { kvGet, kvSet, type Db } from './db.ts';
import type { Log } from './log.ts';

const KEY_OFFSET = 'tg_updates_offset';
const KEY_STRANGER_LOG = 'tg_stranger_log_at';
/** Не чаще раза в час писать в журнал про чужой чат. */
const STRANGER_LOG_MS = 60 * 60 * 1000;

export interface TgChatMessage {
  updateId: number;
  chatId: string;
  /** Текст, если есть; иначе пустая строка (стикер, фото…). */
  text: string;
}

export type InboxClass = 'owner' | 'stranger' | 'ignore';

/** Разобрать update Telegram: сообщение в личке или мимо. */
export function classifyTgUpdate(update: unknown, ownerChatId: string): { kind: InboxClass; msg?: TgChatMessage } {
  if (!update || typeof update !== 'object') return { kind: 'ignore' };
  const u = update as {
    update_id?: unknown;
    message?: {
      chat?: { id?: unknown; type?: unknown };
      text?: unknown;
      caption?: unknown;
    };
  };
  const updateId = Number(u.update_id);
  if (!Number.isInteger(updateId)) return { kind: 'ignore' };
  const msg = u.message;
  if (!msg?.chat || msg.chat.type !== 'private') return { kind: 'ignore' };
  const chatId = String(msg.chat.id);
  const text = typeof msg.text === 'string' ? msg.text
    : typeof msg.caption === 'string' ? msg.caption
    : '';
  const out: TgChatMessage = { updateId, chatId, text };
  if (chatId !== String(ownerChatId).trim()) return { kind: 'stranger', msg: out };
  return { kind: 'owner', msg: out };
}

export interface TgInboxOptions {
  tg: NonNullable<Config['tg']>;
  db: Db;
  log: Log;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Долгий опрос getUpdates, сек (Telegram max 50). */
  pollSec?: number;
  /** Владелец написал — прислать кнопку. */
  onOwnerMessage: (msg: TgChatMessage) => Promise<void>;
  signal: AbortSignal;
}

/**
 * Цикл getUpdates до signal.abort. Перед стартом снимает webhook (иначе getUpdates пуст).
 * Смещение update_id — в kv, чтобы после рестарта не отвечать на старые сообщения пачкой.
 */
export async function runTgInbox(o: TgInboxOptions): Promise<void> {
  const fetchFn = o.fetchFn ?? fetch;
  const now = o.now ?? Date.now;
  const pollSec = Math.min(50, Math.max(1, o.pollSec ?? 25));
  const timeoutMs = (pollSec + 10) * 1000;
  const api = (method: string, body: Record<string, unknown>): Promise<Response> =>
    fetchFn(`${o.tg.apiBase}/bot${o.tg.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([o.signal, AbortSignal.timeout(timeoutMs)]),
    });

  try {
    // Первый запуск без смещения: сбросить хвост, иначе после выкладки прилетит пачка старых сообщений.
    const hadOffset = Boolean(kvGet(o.db, KEY_OFFSET));
    await api('deleteWebhook', { drop_pending_updates: !hadOffset });
  } catch {
    if (o.signal.aborted) return;
    o.log('Telegram inbox: не снял webhook — продолжаю getUpdates');
  }

  if (!kvGet(o.db, KEY_OFFSET)) {
    try {
      const res = await api('getUpdates', { offset: 0, timeout: 0, limit: 100, allowed_updates: ['message'] });
      const json = (await res.json()) as { ok?: boolean; result?: { update_id?: number }[] };
      if (res.ok && json.ok && Array.isArray(json.result) && json.result.length) {
        const last = Math.max(...json.result.map(u => Number(u.update_id) || 0));
        if (last > 0) kvSet(o.db, KEY_OFFSET, String(last + 1));
        o.log(`Telegram inbox: пропустил ${json.result.length} старых обновлений`);
      } else {
        kvSet(o.db, KEY_OFFSET, '1');
      }
    } catch {
      if (o.signal.aborted) return;
      kvSet(o.db, KEY_OFFSET, '1');
    }
  }

  while (!o.signal.aborted) {
    const rawOff = kvGet(o.db, KEY_OFFSET);
    const offset = rawOff && /^\d+$/.test(rawOff) ? Number(rawOff) : 0;
    let updates: unknown[] = [];
    try {
      const res = await api('getUpdates', { offset, timeout: pollSec, allowed_updates: ['message'] });
      const json = (await res.json()) as { ok?: boolean; result?: unknown[]; description?: string };
      if (!res.ok || !json.ok || !Array.isArray(json.result)) {
        if (!o.signal.aborted) o.log(`Telegram inbox: getUpdates не ок (${res.status})`);
        await sleep(o.signal, 3000);
        continue;
      }
      updates = json.result;
    } catch (e) {
      if (o.signal.aborted) return;
      const name = (e as { name?: string }).name;
      if (name !== 'TimeoutError' && name !== 'AbortError') {
        o.log(`Telegram inbox: сеть — ${(e as Error).message}`);
        await sleep(o.signal, 3000);
      }
      continue;
    }

    for (const raw of updates) {
      if (o.signal.aborted) return;
      const classified = classifyTgUpdate(raw, o.tg.chatId);
      const next = (classified.msg?.updateId ?? Number((raw as { update_id?: number }).update_id)) + 1;
      if (Number.isInteger(next) && next > 0) kvSet(o.db, KEY_OFFSET, String(next));

      if (classified.kind === 'ignore' || !classified.msg) continue;

      if (classified.kind === 'stranger') {
        const last = Number(kvGet(o.db, KEY_STRANGER_LOG) ?? 0);
        if (now() - last >= STRANGER_LOG_MS) {
          kvSet(o.db, KEY_STRANGER_LOG, String(now()));
          o.log(`Telegram inbox: чужой чат ${classified.msg.chatId} — молчу`);
        }
        continue;
      }

      try {
        await o.onOwnerMessage(classified.msg);
      } catch (e) {
        o.log(`Telegram inbox: ответ владельцу не ушёл — ${(e as Error).message}`);
      }
    }
  }
}

function sleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
