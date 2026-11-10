/**
 * Saved prompt authority from old B9/JO. [Dispatcher](./reminder-dispatch.mjs)
 * checks a captured plan before claim; [native runner](./prompt-turn.mjs) uses
 * the same plan again before spawn. [Registration](./prompt-registration.mjs) uses
 * the same ordinary-action boundary. [Checks](../../tests/saved-prompt-action.test.mjs).
 */
import { resolveModel } from '../state.mjs';
import { claudeAutoTurnModel, cleanClaudeModelId, getClaudeModel } from '../agent/models.mjs';
import { isLocalReminderEngine } from './reminder-policy.mjs';

const baseTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch'];
const editTools = ['Write', 'Edit', 'NotebookEdit'];

export function savedPromptProvider(state, env = process.env, codexAvailable = false) {
  if (!isLocalReminderEngine(state.engine)) return;
  const subscription = state.authMode === 'subscription' && state.hasSubscriptionAuth;
  const provider = state.extAuthBypass || 'claude';
  if (provider === 'codex' && codexAvailable && subscription && env.JARVIS_CC_ONLY !== '1') return provider;
  const oauth = (!state.authMode || state.authMode === 'subscription') && env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (provider === 'claude' && (subscription || oauth)) return provider;
}

export function ordinarySavedPrompt(action) {
  const { task, authority, capability, output } = action;
  return task?.kind === 'prompt' && ['narrow', 'standard'].includes(authority?.profile ?? 'narrow') &&
    ['none', 'read'].includes(capability ?? 'read') && !task.shell && !task.bashAllow?.length &&
    !action.requiresApproval && action.run?.memory !== 'continuous' && action.memory !== 'continuous' &&
    !action.handoff && !task.sources?.length && !task.freshness && !action.verify?.enabled &&
    !output?.store && (!output?.format || output.format === 'tg-message');
}

export function savedPromptPlan(action, state, env = process.env, codexAvailable = false) {
  if (!ordinarySavedPrompt(action)) return;
  const provider = savedPromptProvider(state, env, codexAvailable);
  if (!provider) return;
  const { task, authority, capability, output } = action;
  if (task.provider && !(provider === 'codex' ? task.provider === 'codex' : ['anthropic', 'claude'].includes(task.provider))) return;

  let model;
  if (provider === 'claude') {
    const explicit = task.model === undefined ? undefined : cleanClaudeModelId(task.model);
    if (explicit !== undefined && !getClaudeModel(explicit) && !/^claude-[a-z0-9][a-z0-9.-]*$/i.test(explicit)) return;
    model = explicit ? resolveModel({ ccModel: explicit })
      : state.ccModel ? claudeAutoTurnModel(resolveModel(state), state.ccModel, env) : undefined;
  } else if (task.model !== undefined) {
    if (typeof task.model !== 'string') return;
    if (/^(?:gpt-|o[1-9])[\w.-]+$/i.test(task.model)) model = task.model;
    else if (task.provider === 'codex') return;
    else {
      const legacy = cleanClaudeModelId(task.model);
      if (!getClaudeModel(legacy) && !/^claude-[a-z0-9][a-z0-9.-]*$/i.test(legacy)) return;
    }
  }
  const tools = [...baseTools];
  if (authority?.profile === 'standard' || (capability ?? 'read') === 'read') tools.push(...editTools);
  if (task.helpers !== false) tools.push('Agent', 'Task');
  const declared = action.budget?.maxRunSeconds;
  const seconds = Number.isFinite(declared) ? Math.min(1800, Math.max(30, Math.round(declared))) : 1800;
  return { provider, model, tools, timeoutMs: seconds * 1000 - 15_000, quiet: output?.emptyIsValidOutcome === true };
}
