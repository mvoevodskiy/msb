/**
 * Saved prompt authority from old B9/JO. [Dispatcher](./reminder-dispatch.mjs)
 * checks a captured plan before claim; [native runner](./prompt-turn.mjs) uses
 * the same plan again before spawn. [Registration](./prompt-registration.mjs) uses
 * the same ordinary-action boundary. Cursor widens admission for legacy
 * freshness/shell/continuous/handoff without opening those on Claude-isolated.
 * [Checks](../../tests/saved-prompt-action.test.mjs),
 * [Cursor checks](../../tests/saved-cursor-prompt.test.mjs).
 */
import { resolveModel } from '../state.mjs';
import { claudeAutoTurnModel, cleanClaudeModelId, getClaudeModel } from '../agent/models.mjs';
import { isLocalReminderEngine } from './reminder-policy.mjs';

const baseTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch'];
const editTools = ['Write', 'Edit', 'NotebookEdit'];
const cursorModelIds = new Set([
  'auto', 'composer-2', 'grok-4.7', 'claude-4.6-opus', 'gpt-5.6-sol', 'gemini-3.1-pro',
]);

export function savedPromptProvider(state, env = process.env, codexAvailable = false, cursorAvailable = false) {
  if (!isLocalReminderEngine(state.engine)) return;
  const subscription = state.authMode === 'subscription' && state.hasSubscriptionAuth;
  const provider = state.extAuthBypass || 'claude';
  if (provider === 'cursor' && cursorAvailable && env.JARVIS_CC_ONLY !== '1') return provider;
  if (provider === 'codex' && codexAvailable && subscription && env.JARVIS_CC_ONLY !== '1') return provider;
  const oauth = (!state.authMode || state.authMode === 'subscription') && env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (provider === 'claude' && (subscription || oauth)) return provider;
}

/** Narrow Claude/Codex admission — no freshness, shell, continuous, or handoff. */
export function ordinarySavedPrompt(action) {
  const { task, authority, capability, output } = action;
  return task?.kind === 'prompt' && ['narrow', 'standard'].includes(authority?.profile ?? 'narrow') &&
    ['none', 'read'].includes(capability ?? 'read') && !task.shell && !task.bashAllow?.length &&
    !action.requiresApproval && action.run?.memory !== 'continuous' && action.memory !== 'continuous' &&
    !action.handoff && !task.sources?.length && !task.freshness && !action.verify?.enabled &&
    !output?.store && (!output?.format || output.format === 'tg-message');
}

/**
 * Legacy Cursor admission for live actions.json rows that ordinary rejects.
 * Still excludes verify/sources/act+approval (P2).
 */
export function legacyCursorSavedPrompt(action) {
  const { task, authority, capability, output } = action;
  if (task?.kind !== 'prompt') return false;
  if (action.requiresApproval) return false;
  if (task.sources?.length || action.verify?.enabled) return false;
  if (output?.store) return false;
  if (output?.format && output.format !== 'tg-message') return false;
  const profile = authority?.profile ?? 'narrow';
  const cap = capability ?? 'read';
  if (!['narrow', 'standard', 'inspect'].includes(profile)) return false;
  if (!['none', 'read', 'scan'].includes(cap)) return false;
  if ((task.shell || task.bashAllow?.length) && !(profile === 'inspect' && cap === 'scan')) return false;
  return true;
}

export function isCursorSavedModelId(model) {
  if (typeof model !== 'string') return false;
  const id = model.trim();
  if (!id) return false;
  if (cursorModelIds.has(id)) return true;
  return /^(auto|composer-[\w.-]+|grok-[\w.-]+|claude-[\w.-]+|gpt-[\w.-]+|gemini-[\w.-]+|o[\d][\w.-]*)$/i.test(id);
}

function planTimeoutMs(action, { cursor = false } = {}) {
  const declared = action.budget?.maxRunSeconds;
  const fallback = cursor ? 1200 : 1800;
  const ceiling = cursor ? 3600 : 1800;
  const seconds = Number.isFinite(declared)
    ? Math.min(ceiling, Math.max(30, Math.round(declared)))
    : fallback;
  return seconds * 1000 - 15_000;
}

export function savedPromptPlan(action, state, env = process.env, codexAvailable = false, cursorAvailable = false) {
  const provider = savedPromptProvider(state, env, codexAvailable, cursorAvailable);
  if (!provider) return;
  const admitted = provider === 'cursor' ? legacyCursorSavedPrompt(action) : ordinarySavedPrompt(action);
  if (!admitted) return;
  const { task, authority, capability, output } = action;
  if (task.provider) {
    if (provider === 'cursor' && task.provider !== 'cursor') return;
    if (provider === 'codex' && task.provider !== 'codex') return;
    if (provider === 'claude' && !['anthropic', 'claude'].includes(task.provider)) return;
  }

  let model;
  let modelError;
  if (provider === 'claude') {
    const explicit = task.model === undefined ? undefined : cleanClaudeModelId(task.model);
    if (explicit !== undefined && !getClaudeModel(explicit) && !/^claude-[a-z0-9][a-z0-9.-]*$/i.test(explicit)) return;
    model = explicit ? resolveModel({ ccModel: explicit })
      : state.ccModel ? claudeAutoTurnModel(resolveModel(state), state.ccModel, env) : undefined;
  } else if (provider === 'cursor') {
    if (task.model !== undefined) {
      if (!isCursorSavedModelId(task.model)) {
        modelError = 'модель не совместима с Cursor: ' + String(task.model);
      } else {
        model = String(task.model).trim();
      }
    }
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
  if (authority?.profile === 'standard' || authority?.profile === 'inspect' || (capability ?? 'read') === 'read' || capability === 'scan') {
    tools.push(...editTools);
  }
  if (provider === 'cursor' && (task.shell || task.bashAllow?.length)) tools.push('Bash');
  if (task.helpers !== false) tools.push('Agent', 'Task');
  const continuous = action.run?.memory === 'continuous' || action.memory === 'continuous';
  const handoff = Boolean(action.handoff);
  const shell = Boolean(task.shell || task.bashAllow?.length);
  const quiet = output?.emptyIsValidOutcome === true;
  return {
    provider,
    model,
    modelError,
    tools,
    timeoutMs: planTimeoutMs(action, { cursor: provider === 'cursor' }),
    quiet,
    continuous: continuous || undefined,
    handoff: handoff || undefined,
    shell: shell || undefined,
  };
}
