/**
 * Structural validation of project routing settings (no provider/auth checks).
 * Modes → [routing-modes](./routing-modes.mjs). Load → [routing-load](./routing-load.mjs).
 */
import { DEFAULT_ROUTING_ALIASES, ROUTING_MODES, isRoutingMode } from './routing-modes.mjs';

const APPLY_MODES = new Set(['sticky', 'once']);

function fail(message) {
  return Object.assign(new Error(message), { code: 'ROUTING_SCHEMA' });
}

function cleanProvider(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('provider должен быть непустой строкой');
  return value.trim();
}

function cleanOptionalString(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw fail(`${field} должен быть строкой или null`);
  const trimmed = value.trim();
  return trimmed || null;
}

function cleanTypeEntry(mode, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(`types.${mode} должен быть объектом`);
  return Object.freeze({
    provider: cleanProvider(raw.provider),
    model: cleanOptionalString(raw.model, `types.${mode}.model`),
    effort: cleanOptionalString(raw.effort, `types.${mode}.effort`),
  });
}

/**
 * @param {unknown} raw
 * @returns {{ version: 1, routing: { enabled: boolean, default: string, apply: 'sticky'|'once', types: object, aliases: object } }}
 */
export function normalizeRoutingSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('корень настроек должен быть объектом');
  if (raw.version !== 1 && raw.version !== '1') throw fail('поддерживается только version: 1');
  const routing = raw.routing;
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) throw fail('нужен блок routing');
  if (!isRoutingMode(routing.default)) throw fail('routing.default должен быть одним из: ' + ROUTING_MODES.join(', '));
  const apply = routing.apply === undefined ? 'sticky' : routing.apply;
  if (!APPLY_MODES.has(apply)) throw fail('routing.apply: sticky или once');
  let enabled = true;
  if (routing.enabled !== undefined) {
    if (typeof routing.enabled !== 'boolean') throw fail('routing.enabled: true или false');
    enabled = routing.enabled;
  }
  const typesRaw = routing.types;
  if (!typesRaw || typeof typesRaw !== 'object' || Array.isArray(typesRaw)) throw fail('routing.types обязателен');
  const missing = ROUTING_MODES.filter(mode => !(mode in typesRaw));
  if (missing.length) throw fail('в routing.types не хватает: ' + missing.join(', '));
  const unknown = Object.keys(typesRaw).filter(key => !isRoutingMode(key));
  if (unknown.length) throw fail('неизвестные режимы в types: ' + unknown.join(', '));
  const types = Object.freeze(Object.fromEntries(ROUTING_MODES.map(mode => [mode, cleanTypeEntry(mode, typesRaw[mode])])));

  const aliases = { ...DEFAULT_ROUTING_ALIASES };
  const aliasRaw = routing.aliases;
  if (aliasRaw !== undefined) {
    if (!aliasRaw || typeof aliasRaw !== 'object' || Array.isArray(aliasRaw)) throw fail('routing.aliases должен быть объектом');
    for (const [key, target] of Object.entries(aliasRaw)) {
      const alias = String(key || '').trim().toLowerCase();
      if (!alias) throw fail('пустой alias');
      if (!isRoutingMode(target)) throw fail(`alias «${alias}» → неизвестный режим`);
      aliases[alias] = target;
    }
  }
  for (const mode of ROUTING_MODES) aliases[mode] = mode;

  return Object.freeze({
    version: 1,
    routing: Object.freeze({
      enabled,
      default: routing.default,
      apply,
      types,
      aliases: Object.freeze(aliases),
    }),
  });
}

/** Absent/true → on; explicit false → off (file kept). */
export function isRoutingEnabled(settings) {
  return settings?.routing?.enabled !== false;
}
