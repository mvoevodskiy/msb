/**
 * Идентичность X и ограниченные Telegram callback источников мониторинга.
 * Входы: config/list, poll и экран источников; удаление сверяет тот же token.
 * Проверки: ../../tests/monitor-twitter-legacy.test.mjs, monitor-callback.test.mjs.
 */
import { createHash } from 'node:crypto';

// Telegram callback_data is limited to 64 bytes, including the prefix.
export function sourceToken(type, id) {
  return createHash('sha256').update(JSON.stringify([type, id])).digest('hex').slice(0, 32);
}

export function sourceCallbackData(type, id) {
  // An old broken X button encoded an absent id as the literal 'undefined'.
  // Its callback cannot be distinguished from the real username, so new
  // buttons for that real account must use a token.
  if (type === 'twitter' && id === 'undefined') return `mon:src-key:${type}:${sourceToken(type, id)}`;
  let legacy;
  try { legacy = `mon:src-del:${type}:${encodeURIComponent(id)}`; } catch { /* use a bounded token */ }
  if (legacy && Buffer.byteLength(legacy) <= 64) return legacy;
  return `mon:src-key:${type}:${sourceToken(type, id)}`;
}

// Old profiles store X accounts in handle; open-core stores username. Do not
// choose either field if both are present but identify different accounts.
export function twitterAliases(account) {
  return [account?.username, account?.handle].filter((value) => typeof value === 'string' && value.trim());
}

export function twitterIdentity(account) {
  const fields = [account?.username, account?.handle];
  if (fields.some((value) => value != null && typeof value !== 'string')) return null;
  const aliases = twitterAliases(account);
  if (!aliases.length || new Set(aliases.map((value) => value.toLowerCase())).size !== 1) return null;
  return aliases[0];
}
