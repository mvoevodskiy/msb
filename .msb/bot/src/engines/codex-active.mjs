/** Selected Codex CLI boundary used by [sleep](./sleep.mjs) and its
 * [wake callback](../telegram/routes/engines.mjs); no state mutation. */
export function isCodexSelected(state) {
  return state?.extAuthBypass === 'codex' && state.engine !== 'oc';
}
