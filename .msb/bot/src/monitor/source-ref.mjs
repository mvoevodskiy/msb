import { createHash } from 'node:crypto';

// Telegram callback_data is limited to 64 bytes, including the prefix.
export function sourceToken(type, id) {
  return createHash('sha256').update(JSON.stringify([type, id])).digest('hex').slice(0, 32);
}

export function sourceCallbackData(type, id) {
  let legacy;
  try { legacy = `mon:src-del:${type}:${encodeURIComponent(id)}`; } catch { /* use a bounded token */ }
  if (legacy && Buffer.byteLength(legacy) <= 64) return legacy;
  return `mon:src-key:${type}:${sourceToken(type, id)}`;
}
