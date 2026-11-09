/**
 * Saved prompt authority from old B9/JO. [Dispatcher](./reminder-dispatch.mjs)
 * checks a captured plan before claim; [native runner](./prompt-turn.mjs) uses
 * the same plan again before spawn. [Checks](../../tests/saved-prompt-action.test.mjs).
 */
import { resolveModel } from '../state.mjs';
import { claudeAutoTurnModel, cleanClaudeModelId, getClaudeModel } from '../agent/models.mjs';
import { isLocalReminderEngine } from './reminder-policy.mjs';

const baseTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch'];
const editTools = ['Write', 'Edit', 'NotebookEdit'];

export function savedPromptPlan(action, state, env = process.env) {
  const { task, authority, capability, output } = action;
  const subscription = state.authMode === 'subscription' && state.hasSubscriptionAuth;
  const oauth = (!state.authMode || state.authMode === 'subscription') && env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (task?.kind !== 'prompt' || !isLocalReminderEngine(state.engine) ||
      (state.extAuthBypass && state.extAuthBypass !== 'claude') || (!subscription && !oauth)) return;
  if (task.provider && !['anthropic', 'claude'].includes(task.provider)) return;
  const posture = authority?.profile ?? 'narrow';
  const grant = capability ?? 'read';
  if (!['narrow', 'standard'].includes(posture) || !['none', 'read'].includes(grant) || task.shell ||
      task.bashAllow?.length || action.requiresApproval || action.run?.memory === 'continuous' || action.memory === 'continuous' ||
      action.handoff || task.team?.length || task.sources?.length || task.freshness || action.verify?.enabled ||
      output?.store || (output?.format && output.format !== 'tg-message')) return;

  const explicit = task.model === undefined ? undefined : cleanClaudeModelId(task.model);
  if (explicit !== undefined && !getClaudeModel(explicit) && !/^claude-[a-z0-9][a-z0-9.-]*$/i.test(explicit)) return;
  const model = explicit ? resolveModel({ ccModel: explicit })
    : state.ccModel ? claudeAutoTurnModel(resolveModel(state), state.ccModel, env) : undefined;
  const tools = [...baseTools];
  if (posture === 'standard' || grant === 'read') tools.push(...editTools);
  if (task.helpers !== false) tools.push('Agent', 'Task');
  const declared = action.budget?.maxRunSeconds;
  const seconds = Number.isFinite(declared) ? Math.min(1800, Math.max(30, Math.round(declared))) : 1800;
  return { model, tools, timeoutMs: seconds * 1000 - 15_000, quiet: output?.emptyIsValidOutcome === true };
}
