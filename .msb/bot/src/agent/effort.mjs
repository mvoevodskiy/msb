/**
 * Old Claude effort preference → supported native flag, without state mutation.
 * Callers: [state resolver](../state.mjs), [Claude screen](../telegram/screens/agent.mjs).
 * Input model is the resolved CLI ID; catalog/version selection stays elsewhere.
 * Codex effort is owned by its provider store/adapter, not this Claude policy.
 * Checks: [production argv/UI/compact](../../tests/claude-effort.test.mjs);
 * provenance: [contract](../../tests/reference/parity-agent-settings-contract.txt).
 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const isClaudeEffort = value => CLAUDE_EFFORTS.includes(value);
const nativeId = model => String(model || '').trim().toLowerCase().replace(/\[1m\]$/, '');
export function supportsClaudeEffort(model) {
  const id = nativeId(model);
  return id !== 'haiku' && !id.startsWith('claude-haiku-4-5');
}
export function claudeEffortFlag(model, preference) {
  if (!isClaudeEffort(preference) || !supportsClaudeEffort(model)) return undefined;
  if (preference !== 'xhigh' && preference !== 'max') return preference;
  const id = nativeId(model);
  const opus = id === 'opus' || id === 'opusplan' || id.startsWith('claude-opus-');
  if (!opus) return 'high';
  // Old pinned Opus4.6 options include max but not xhigh (Xm in reference).
  if (preference === 'xhigh' && id === 'claude-opus-4-6') return 'high';
  return preference;
}
