/**
 * Provider-input ownership, read by [text admission](./integration/text-input.mjs).
 * Originating chat is checked before expiry; an expired entry remains available
 * to consume its late reply instead of forwarding a secret to the model.
 * [Checks](./tests/input-scope.test.mjs).
 */
import { INPUT_TTL_MS } from '../shared/input-notices.mjs';

const pending = new Map(); // userId -> { providerId, at, chatId, step?, draft? }

export function setPendingAuth(userId, providerId, chatId, extra = {}) {
  pending.set(Number(userId), {
    providerId,
    chatId: Number(chatId),
    at: Date.now(),
    step: extra.step || 'key',
    draft: extra.draft && typeof extra.draft === 'object' ? { ...extra.draft } : {},
  });
}

export function clearPendingAuth(userId, { chatId } = {}) {
  const row = pending.get(Number(userId));
  if (chatId !== undefined && row?.chatId !== Number(chatId)) return false;
  return pending.delete(Number(userId));
}

export function getPendingAuth(userId, { chatId, includeExpired = false } = {}) {
  const row = pending.get(Number(userId));
  if (!row || (chatId !== undefined && row.chatId !== Number(chatId))) return null;
  if (Date.now() - row.at > INPUT_TTL_MS) {
    if (includeExpired) return { ...row, expired: true };
    pending.delete(Number(userId));
    return null;
  }
  return row;
}
