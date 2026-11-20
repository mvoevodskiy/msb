/**
 * Pinned old Claude catalog data, not a live vendor/product availability claim.
 * [Model policy](../src/agent/models.mjs) owns locks/aliases; overlay callbacks
 * use isClaudeModelChoice to keep historical stock buttons out of Codex config.
 * Source: old blob73aa9e7, V1 412–644; [contract](../tests/reference/parity-model-catalog-contract.txt).
 * Checks: [production catalog](../tests/model-catalog.test.mjs).
 */
export const CLAUDE_MODELS = Object.freeze([
  Object.freeze({"key": "opus", "cliModel": "opus", "family": "opus", "kind": "alias", "label": "Opus, последняя версия", "shortLabel": "Opus", "button": "🧠 Opus авто", "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high", "cliDefaultEffort": "high"}),
  Object.freeze({"key": "opus55", "cliModel": "claude-opus-5-5", "family": "opus", "kind": "pinned", "label": "Opus 5.5", "shortLabel": "Opus 5.5", "button": "🧠 Opus 5.5", "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high", "cliDefaultEffort": "medium", "minCcCli": "2.1.280"}),
  Object.freeze({"key": "opus5", "cliModel": "claude-opus-5", "family": "opus", "kind": "pinned", "label": "Opus 5", "shortLabel": "Opus 5", "button": "🧠 Opus 5", "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high", "cliDefaultEffort": "high", "minCcCli": "2.1.219"}),
  Object.freeze({"key": "opus48", "cliModel": "claude-opus-4-8", "family": "opus", "kind": "pinned", "label": "Opus 4.8", "shortLabel": "Opus 4.8", "button": "🧠 Opus 4.8", "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high", "cliDefaultEffort": "high", "minCcCli": "2.1.154"}),
  Object.freeze({"key": "opus47", "cliModel": "claude-opus-4-7", "family": "opus", "kind": "pinned", "label": "Opus 4.7", "shortLabel": "Opus 4.7", "button": "🧠 Opus 4.7", "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "xhigh", "cliDefaultEffort": "xhigh", "minCcCli": "2.1.154"}),
  Object.freeze({"key": "opus46", "cliModel": "claude-opus-4-6", "family": "opus", "kind": "pinned", "label": "Opus 4.6", "shortLabel": "Opus 4.6", "button": "🧠 Opus 4.6", "efforts": ["low", "medium", "high", "max"], "defaultEffort": "high", "cliDefaultEffort": "high", "minCcCli": "2.1.154"}),
  Object.freeze({"key": "opusplan", "cliModel": "opusplan", "family": "opus", "kind": "alias", "label": "Opus + план", "shortLabel": "Opus+план", "button": "🧠 Opus + план", "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high", "cliDefaultEffort": "high", "retiredTo": "opus"}),
  Object.freeze({"key": "sonnet", "cliModel": "sonnet", "family": "sonnet", "kind": "alias", "label": "Sonnet, последняя версия", "shortLabel": "Sonnet", "button": "🚀 Sonnet авто", "efforts": ["low", "medium", "high"], "defaultEffort": "high", "cliDefaultEffort": "high"}),
  Object.freeze({"key": "sonnet55", "cliModel": "claude-sonnet-5-5", "family": "sonnet", "kind": "pinned", "label": "Sonnet 5.5", "shortLabel": "Sonnet 5.5", "button": "🚀 Sonnet 5.5", "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high", "cliDefaultEffort": "medium", "minCcCli": "2.1.284"}),
  Object.freeze({"key": "sonnet5", "cliModel": "claude-sonnet-5", "family": "sonnet", "kind": "pinned", "label": "Sonnet 5", "shortLabel": "Sonnet 5", "button": "🚀 Sonnet 5", "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high", "cliDefaultEffort": "high", "minCcCli": "2.1.197"}),
  Object.freeze({"key": "sonnet46", "cliModel": "claude-sonnet-4-6", "family": "sonnet", "kind": "pinned", "label": "Sonnet 4.6", "shortLabel": "Sonnet 4.6", "button": "🚀 Sonnet 4.6", "efforts": ["low", "medium", "high", "max"], "defaultEffort": "high", "cliDefaultEffort": "high", "minCcCli": "2.1.154"}),
  Object.freeze({"key": "haiku", "cliModel": "haiku", "family": "haiku", "kind": "alias", "label": "Haiku, последняя версия", "shortLabel": "Haiku", "button": "🪶 Haiku авто", "efforts": ["low", "medium", "high"], "defaultEffort": "high", "cliDefaultEffort": "high"}),
  Object.freeze({"key": "haiku55", "cliModel": "claude-haiku-5-5", "family": "haiku", "kind": "pinned", "label": "Haiku 5.5", "shortLabel": "Haiku 5.5", "button": "🪶 Haiku 5.5", "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high", "cliDefaultEffort": "medium", "minCcCli": "2.1.293"}),
  Object.freeze({"key": "fable51", "cliModel": "claude-fable-5-1", "family": "fable", "kind": "pinned", "label": "Fable 5.1", "shortLabel": "Fable 5.1", "button": "🔮 Fable 5.1", "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high", "cliDefaultEffort": "high", "minCcCli": "2.1.251"}),
  Object.freeze({"key": "fable5", "cliModel": "claude-fable-5", "family": "fable", "kind": "pinned", "label": "Fable 5", "shortLabel": "Fable 5", "button": "🔮 Fable 5", "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high", "cliDefaultEffort": "high", "minCcCli": "2.1.197"})
]);

export function cleanClaudeModelId(value) {
  const id = String(value || '').trim();
  return id.toLowerCase().endsWith('[1m]') ? id.slice(0, -4) : id;
}
export function getClaudeModel(value) {
  const id = cleanClaudeModelId(value).toLowerCase();
  const model = CLAUDE_MODELS.find(m => m.key.toLowerCase() === id || m.cliModel.toLowerCase() === id);
  return model?.retiredTo ? CLAUDE_MODELS.find(m => m.key === model.retiredTo) : model;
}
export function isClaudeModelChoice(value) {
  const id = cleanClaudeModelId(value).toLowerCase();
  return Boolean(getClaudeModel(id)) || ['opus','sonnet','haiku','fable'].some(family =>
    id === family || id.startsWith(family + '-') || id.startsWith('claude-' + family + '-'));
}
