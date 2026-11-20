/**
 * Which foreground providers expose mid-turn «Учесть сейчас».
 * Codex → app-server `turn/steer`; Claude → stream-json stdin;
 * Cursor/Grok → ACP (Cursor: send-now via second `session/prompt`;
 * Grok: `_x.ai/interject` when the CLI advertises it).
 * Overlay FD bridge → [claude envelope](./claude.mjs) + [shim](../../../../overlay/bot/ext/shim/steer-control.mjs).
 * [Turn gate](./turn.mjs), [envelope checks](../../tests/steer-envelope.test.mjs).
 */

const STEERABLE = new Set(['claude', 'codex', 'cursor', 'grok']);

/** Overlay providers that receive the private control fd (not Claude stdin). */
const OVERLAY_STEER_FD = new Set(['codex', 'cursor', 'grok']);

export function supportsSteer(providerId) {
  return STEERABLE.has(providerId || 'claude');
}

export function usesSteerControlFd(providerId) {
  return OVERLAY_STEER_FD.has(providerId);
}
