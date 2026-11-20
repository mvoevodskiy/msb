/**
 * Active CLI identity for routing compare. Mirrors overlay decode when present;
 * core-only bots treat missing bypass as Claude.
 */
export function currentSessionProvider(state = {}) {
  const id = state.ccSessionId;
  if (typeof id === 'string' && id.startsWith('ext:')) {
    const rest = id.slice(4);
    const sep = rest.indexOf(':');
    if (sep > 0) return rest.slice(0, sep);
  }
  if (typeof state.extAuthBypass === 'string' && state.extAuthBypass) return state.extAuthBypass;
  return 'claude';
}
