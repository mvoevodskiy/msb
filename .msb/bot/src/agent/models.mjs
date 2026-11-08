/**
 * Old Claude alias/version/lock/default metadata policy; pure, no CLI or writes.
 * Data → [shared catalog](../../shared/claude-models.mjs); native metadata →
 * [version reader](./claude-version.mjs); [screens](../telegram/screens/models.mjs)
 * and [choice route](../telegram/routes/models.mjs) consume the same options.
 * Tests: [catalog ingress](../../tests/model-catalog.test.mjs), [effort](../../tests/claude-effort.test.mjs).
 */
import { CLAUDE_MODELS, getClaudeModel, cleanClaudeModelId } from '../../shared/claude-models.mjs';
export { getClaudeModel, cleanClaudeModelId };
export const MODEL_FAMILIES = [
  { id: 'fable', button: '🔮 Fable', line: 'самая мощная модель Anthropic.' },
  { id: 'opus', button: '🧠 Opus', line: 'основная. Код, сложные задачи, долгая самостоятельная работа.' },
  { id: 'sonnet', button: '🚀 Sonnet', line: 'быстрее и бережёт лимит. Повседневная работа.' },
  { id: 'haiku', button: '🪶 Haiku', line: 'самая быстрая. Простые задачи и короткие ответы.' },
];
const semver = value => String(value || '').match(/[0-9]+[.][0-9]+[.][0-9]+/)?.[0].split('.').map(Number);
export function compareCliVersion(value, minimum) {
  const a = semver(value), b = semver(minimum);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export const cliVersionReadable = value => compareCliVersion(value, '0.0.0') !== null;
export const modelLocked = (model, version) => Boolean(model.minCcCli && (compareCliVersion(version, model.minCcCli) ?? -1) < 0);
export const modelOptions = version => CLAUDE_MODELS.filter(m => !m.retiredTo).map(model => ({ model, locked: modelLocked(model, version) }));
export const isFamilyAlias = model => model.kind === 'alias' && model.key === model.family;
const thresholds = {
  opus: [['2.1.280','5.5'],['2.1.219','5'],['2.1.154','4.8']],
  sonnet: [['2.1.284','5.5'],['2.1.197','5']], haiku: [['2.1.293','5.5']],
};
export function resolvedFamilyVersion(family, version) {
  const fallback = family === 'opus' ? '4.7' : family === 'sonnet' ? '4.6' : '4.5';
  return (thresholds[family] || []).find(([min]) => (compareCliVersion(version, min) ?? -1) >= 0)?.[1] || fallback;
}
export function resolvedModelOnCli(value, version) {
  const model = getClaudeModel(value);
  if (!model || model.kind === 'pinned') return model || null;
  if (!cliVersionReadable(version)) return null;
  return getClaudeModel('claude-' + model.family + '-' + resolvedFamilyVersion(model.family, version).replaceAll('.', '-')) || null;
}
export function defaultModelEffort(value, version) {
  const model = resolvedModelOnCli(value, version);
  if (!model) return { level: 'high', flag: undefined };
  if (model.defaultEffort === model.cliDefaultEffort) return { level: model.defaultEffort, flag: undefined };
  if (!model.minCcCli || !modelLocked(model, version)) return { level: model.defaultEffort, flag: model.defaultEffort };
  return { level: model.cliDefaultEffort, flag: undefined };
}
export function familyChoice(family, version) {
  const options = modelOptions(version).filter(o => o.model.family === family);
  return options.find(o => isFamilyAlias(o.model)) || options.find(o => !o.locked) || options[0];
}
export function modelShortLabel(value, version) {
  const model = getClaudeModel(value);
  if (!model) return cleanClaudeModelId(value) || 'Opus';
  return isFamilyAlias(model) && cliVersionReadable(version) ? model.shortLabel + ' ' + resolvedFamilyVersion(model.family, version) : model.shortLabel;
}
export function modelCallbackChoice(data, version) {
  const prefixes = ['settings:model:set:', 'settings:model:fable:', 'settings:model:fableok:'];
  const prefix = prefixes.find(p => data.startsWith(p));
  if (!prefix) return null;
  const key = data.slice(prefix.length);
  // Compatibility with an already sent open-core Fable family link, no confirm UI.
  if (prefix === prefixes[1] && key === 'ask') return familyChoice('fable', version);
  const model = CLAUDE_MODELS.find(m => !m.retiredTo && m.key === key);
  if (!model || (prefix !== prefixes[0] && model.family !== 'fable')) return null;
  return { model, locked: modelLocked(model, version) };
}
