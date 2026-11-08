/**
 * Stateless names → bounded Telegram references; no registry, values or I/O.
 * Callers: [env](../src/env/callback-key.mjs), [projects](../src/projects/callback-key.mjs),
 * [sessions](../src/sessions/callback-key.mjs).
 * Unknown/ambiguous digests never select another current name. Short literals keep
 * their existing route. [Env checks](../tests/env-callbacks.test.mjs), [project checks](../tests/projects.test.mjs).
 */
import {createHash} from 'node:crypto';

export function nameReference(name, {marker, actionPrefix, maxLiteralChars = Infinity, reservedNames = []}) {
  if (name.length <= maxLiteralChars && !name.startsWith(marker) && !reservedNames.includes(name)
    && Buffer.byteLength(actionPrefix + name, 'utf8') <= 64) return name;
  const reference = marker + createHash('sha256').update(name).digest('hex').slice(0, 32);
  if (Buffer.byteLength(actionPrefix + reference, 'utf8') > 64) throw new RangeError('Callback action prefix is too long');
  return reference;
}

export function resolveNameReference(reference, names, options) {
  if (!reference.startsWith(options.marker)) return reference;
  if (!/^[0-9a-f]{32}$/.test(reference.slice(options.marker.length))) return null;
  const matching = names.filter(name => nameReference(name, options) === reference);
  return matching.length === 1 ? matching[0] : null;
}
