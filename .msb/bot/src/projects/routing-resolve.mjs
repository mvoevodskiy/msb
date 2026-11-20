/**
 * Resolve active mode from message prefix → one-shot → sticky → default.
 * Modes/aliases → [routing-modes](./routing-modes.mjs).
 */
import { isRoutingMode } from './routing-modes.mjs';

// Do not use \\b — it is ASCII-only and breaks Cyrillic aliases like #анализ.
const PREFIX = /^#([\p{L}\p{N}_-]+)(?:[ \t]+|$)/u;

/**
 * @param {string} token
 * @param {Record<string,string>} aliases
 * @returns {string|null}
 */
export function normalizeModeToken(token, aliases = {}) {
  const key = String(token || '').trim().toLowerCase();
  if (!key) return null;
  const mapped = aliases[key];
  return isRoutingMode(mapped) ? mapped : null;
}

/**
 * @param {object} opts
 * @param {string} [opts.text]
 * @param {string|null} [opts.stickyMode] state.projectTaskMode
 * @param {string|null} [opts.onceMode] state.projectTaskModeOnce
 * @param {object} opts.routing normalized routing block
 * @param {string|null} [opts.forcedMode] already-canonical mode from caller
 */
export function resolveTaskMode({
  text = '',
  stickyMode = null,
  onceMode = null,
  routing,
  forcedMode = null,
} = {}) {
  if (!routing) return { mode: null, prompt: text, source: 'off', stickyNext: null, clearOnce: false };
  const aliases = routing.aliases || {};
  let prompt = typeof text === 'string' ? text : '';
  let mode = null;
  let source = 'default';
  let clearOnce = false;

  if (forcedMode && isRoutingMode(forcedMode)) {
    mode = forcedMode;
    source = 'forced';
  } else {
    const match = prompt.match(PREFIX);
    if (match) {
      const fromPrefix = normalizeModeToken(match[1], aliases);
      if (!fromPrefix) {
        return {
          mode: null,
          prompt,
          source: 'prefix-invalid',
          error: `неизвестный режим #${match[1]}`,
          stickyNext: stickyMode && isRoutingMode(stickyMode) ? stickyMode : null,
          clearOnce: false,
        };
      }
      mode = fromPrefix;
      source = 'prefix';
      prompt = prompt.slice(match[0].length);
    } else if (onceMode && isRoutingMode(onceMode)) {
      mode = onceMode;
      source = 'once';
      clearOnce = true;
    } else if (routing.apply === 'sticky' && stickyMode && isRoutingMode(stickyMode)) {
      mode = stickyMode;
      source = 'sticky';
    } else {
      mode = routing.default;
      source = 'default';
    }
  }

  // Prefix/once override one message; sticky rewritten only by /type (forced).
  let stickyNext = stickyMode && isRoutingMode(stickyMode) ? stickyMode : null;
  if (source === 'forced' && routing.apply === 'sticky') stickyNext = mode;
  else if (routing.apply === 'sticky' && source === 'default' && !stickyNext) stickyNext = mode;

  return { mode, prompt, source, stickyNext, clearOnce, route: routing.types[mode] };
}
