/**
 * Old Claude effort preference → supported native flag, without state mutation.
 * Callers: [state resolver](../state.mjs), [Claude screen](../telegram/screens/agent.mjs).
 * Input model is the resolved CLI ID; catalog/version selection stays elsewhere.
 * Codex effort is owned by its provider store/adapter, not this Claude policy.
 * Checks: [production argv/UI/compact](../../tests/claude-effort.test.mjs);
 * provenance: [contract](../../tests/reference/parity-agent-settings-contract.txt).
 */
import { getClaudeModel, cleanClaudeModelId, resolvedFamilyVersion, resolvedModelOnCli, defaultModelEffort } from './models.mjs';
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const isClaudeEffort = value => CLAUDE_EFFORTS.includes(value);
export function supportsClaudeEffort(model, version) {
  const id = cleanClaudeModelId(model).toLowerCase(), selected = getClaudeModel(id);
  if (id.startsWith('claude-haiku-4-5')) return false;
  return !(selected?.kind === 'alias' && selected.family === 'haiku' && resolvedFamilyVersion('haiku',version) === '4.5');
}
export function claudeEffortFlag(model, preference, version) {
  if (!supportsClaudeEffort(model,version)) return undefined;
  if (preference === 'off') return undefined; // Preserve the former open-core native-default preference.
  if (!preference) return defaultModelEffort(model,version).flag;
  if (!isClaudeEffort(preference)) return undefined;
  if (preference !== 'xhigh' && preference !== 'max') return preference;
  const id = cleanClaudeModelId(model).toLowerCase(), selected = getClaudeModel(id);
  const opus = selected ? selected.family === 'opus' : id === 'opus' || id === 'opusplan' || id.startsWith('claude-opus-');
  if (!opus) return 'high';
  const resolved = resolvedModelOnCli(model,version);
  return resolved && !resolved.efforts.includes(preference) ? 'high' : preference;
}

export function effectiveClaudeEffort(model, preference, version) {
  if (!supportsClaudeEffort(model,version)) return null;
  if (preference && !isClaudeEffort(preference)) return resolvedModelOnCli(model,version)?.cliDefaultEffort || 'high';
  return claudeEffortFlag(model,preference,version) || defaultModelEffort(model,version).level;
}
