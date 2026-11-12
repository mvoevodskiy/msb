/**
 * Redaction and secret-path guards for the external MCP surface.
 * Reuses bot [historyPreview](../../bot/src/history/preview.mjs); never returns .env values.
 */
import path from 'node:path';
import { historyPreview } from '../../bot/src/history/preview.mjs';

const SECRET_KEY = /(?:^|[._-])(token|secret|password|passwd|api[_-]?key|authorization|private[_-]?key|bot_token|access_key)(?:$|[._-])/i;
const BLOCKED_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'credentials.json',
  'credentials',
  'id_rsa',
  'id_ed25519',
]);

export function isBlockedRelative(relative) {
  const parts = String(relative || '').split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return false;
  for (const part of parts) {
    const base = path.basename(part).toLowerCase();
    if (BLOCKED_NAMES.has(base)) return true;
    if (base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.p12')) return true;
    if (base.startsWith('.env.') && base !== '.env.example') return true;
    if (SECRET_KEY.test(base) && !base.endsWith('.md') && !base.endsWith('.txt.example')) return true;
  }
  return false;
}

export function sanitizeValue(value, key = '') {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key)) return '[скрыто]';
    return historyPreview(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeValue(v, k);
    return out;
  }
  return value;
}

export function sanitizeState(state) {
  if (!state || typeof state !== 'object') return {};
  return sanitizeValue(state);
}

export { historyPreview };
