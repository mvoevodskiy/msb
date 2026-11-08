/**
 * Old ATA/Dy role: bounded env key reference, shared by list/confirmation/routes.
 * Current key names resolve refs after restart; no values, registry or file writes.
 * [Screens](../telegram/screens/settings.mjs), [routes](../telegram/routes/settings.mjs),
 * [contract](../../tests/reference/parity-env-callback-contract.txt),
 * [production checks](../../tests/env-callbacks.test.mjs).
 */
import { createHash } from 'node:crypto';
const PREFIX = 'k~';
const CONFIRM_PREFIX = 'settings:env:confirm-delete:';
export function envKeyReference(key) {
  if (key.length <= 30 && !key.startsWith(PREFIX) && Buffer.byteLength(CONFIRM_PREFIX + key) <= 64) return key;
  return PREFIX + createHash('sha256').update(key).digest('hex').slice(0,32);
}

export function resolveEnvKeyReference(reference, keys) {
  if (!reference.startsWith(PREFIX)) return reference;
  if (!/^k~[0-9a-f]{32}$/.test(reference)) return null;
  const matching = keys.filter(key => envKeyReference(key) === reference);
  return matching.length === 1 ? matching[0] : null;
}
