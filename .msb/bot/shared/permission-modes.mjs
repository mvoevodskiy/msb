/**
 * Old UI mode vocabulary, shared by core choice setters and overlay callbacks.
 * [Claude CLI mapping](../src/state.mjs) and [prompt](../src/agent/mode-prompt.mjs)
 * are separate from Codex native rights. Checks: agent-modes.test.mjs.
 */
export const VISIBLE_PERMISSION_MODES = [
  { id: 'auto', label: 'Без спроса', desc: 'делает всё сам, не спрашивая (по умолчанию)' },
  { id: 'control', label: 'С подтверждением', desc: '✔/✖ перед каждым изменением файла' },
  { id: 'plan', label: 'Сначала план', desc: 'показывает план, ждёт ✔, потом делает всё' },
];
const allowed = new Set(['auto', 'smart', 'control', 'plan']);
// Old I2 fallback is auto, including unrecognized historical callback suffixes.
export const normalizePermissionMode = value => allowed.has(value) ? value : 'auto';
