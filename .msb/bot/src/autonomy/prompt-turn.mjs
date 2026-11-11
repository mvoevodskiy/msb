/**
 * Execute a stateless saved prompt in the old autonomy workspace. [Policy](./prompt-policy.mjs)
 * supplies the tools for [Claude](../agent/claude.mjs), the registered Codex adapter,
 * or the Cursor adapter. [Freshness](./prompt-freshness.mjs) refuses before spawn.
 * [Saved roles](./prompt-team.mjs) use the same tool boundary and claimed action.
 * [Dispatcher](./reminder-dispatch.mjs) owns cancellation, delivery and history.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { runClaudeTurn } from '../agent/claude.mjs';
import { actionRoot, botRoot, homeDir, msbRoot, sessionDir } from '../paths.mjs';
import { loadState } from '../state.mjs';
import { savedPromptPlan } from './prompt-policy.mjs';
import { checkSavedPromptFreshness } from './prompt-freshness.mjs';
import { savedClaudeHelperRoles, savedClaudeHelpersSupported, savedClaudeTeamRoster } from './saved-claude-helpers.mjs';
import { promptTeamInstructions, savedPromptTeam } from './prompt-team.mjs';
import { physicalRecordPath } from './record-file.mjs';

const quietMarker = '[NOTHING_TO_REPORT]';
const stopped = { status: 'stopped', detail: 'ход прерван остановкой фоновых задач' };
const deferred = { status: 'deferred', detail: 'изолированный запуск сейчас недоступен' };

async function protectedPaths(env, provider) {
  const home = homeDir(env);
  const runtime = msbRoot(env);
  const bot = botRoot(env);
  const action = actionRoot(env);
  const paths = [path.join(home, '.ssh', '**'), path.join(home, '.scripter', '**'),
    path.join(home, '.claude', '**'), path.join(home, '.claude.json'), path.join(home, '.codex', '**'),
    path.join(home, '.cursor', '**'),
    path.join(runtime, '.env'), path.join(runtime, 'state.json'), path.join(runtime, 'sessions', '**'),
    path.join(runtime, 'bots', '**', '.env'), path.join(runtime, 'bots', '**', 'state.json'),
    path.join(runtime, 'bots', '**', 'ext-providers.json'), path.join(runtime, 'bots', '**', 'sessions', '**'),
    path.join(bot, '.env'), path.join(bot, 'state.json'), path.join(bot, 'ext-providers.json'),
    path.join(sessionDir(env), '**'), path.join(action, 'actions.json'), path.join(action, 'autonomy', '*.json*')];
  if (provider === 'codex' || provider === 'cursor') {
    paths.push(path.join(runtime, 'bots', '**', 'actions.json'),
      path.join(action, '.records-*', '**'), path.join(action, 'autonomy', '.records-*', '**'));
  }
  if (env.CLAUDE_CONFIG_DIR) paths.push(path.join(env.CLAUDE_CONFIG_DIR, '**'));
  if (env.CODEX_HOME) paths.push(path.join(env.CODEX_HOME, '**'));
  const physical = await Promise.all(paths.map(value => physicalRecordPath(path.resolve(value)).catch(() => path.resolve(value))));
  return [...new Set([...paths.map(value => path.resolve(value)), ...physical])];
}

function workspaceName(provider) {
  return provider === 'cursor' ? 'cursor-workspace' : 'cc-workspace';
}

function taskInstructions(action, { quiet, provider, tools, handoff, shell }, teamPrompt) {
  const fields = ['canWithoutApproval', 'needsApproval', 'escalateWhen', 'whatNotToDo'];
  const saved = action.authority ?? {};
  const lines = ['Твои полномочия на этом ходу (владелец записал их заранее, спросить его сейчас нельзя).',
    'Работай в рамках доступных инструментов. Результат получит владелец задачи в Telegram.'];
  if ((provider === 'codex' || provider === 'cursor') && tools.includes('Agent')) {
    lines.push('В этом задании можно привлекать помощников. Передавай им часть задания в рамках тех же полномочий.');
  }
  if (provider === 'cursor' && handoff) {
    const next = typeof action.handoff?.next === 'string' ? action.handoff.next.trim() : '';
    lines.push('Handoff: делегируй куски работы внутри этого хода (подзадачи/агенты Cursor), без публикации наружу.'
      + (next ? ' Дальше по плану: ' + next.slice(0, 350) : ''));
  }
  if (provider === 'cursor' && shell) {
    lines.push('Разрешены shell-команды в рамках задания (inspect/scan). Не трогай секреты и чужие аккаунты.');
  }
  const labels = ['Разрешено без согласования', 'Требует согласования', 'Когда сообщить владельцу', 'Запрещено'];
  for (const [index, field] of fields.entries()) {
    const entries = Array.isArray(saved[field]) ? saved[field].filter(value => typeof value === 'string') : [];
    if (entries.length) lines.push(labels[index] + ' — ' + entries.join(', ').slice(0, 350));
  }
  lines.push('', action.task.prompt);
  if (quiet) lines.push('', 'Если сообщать нечего — ответь одной строкой ' + quietMarker + '.');
  if (teamPrompt) lines.push('', teamPrompt);
  if ((provider === 'claude' || provider === 'cursor') && action.task.helpers === false) {
    lines.push('', 'Помощников не зови, всю работу делай сам: так попросил владелец.');
  }
  return lines.join('\n');
}

function quietText(value) {
  return value.replace(/```[a-z]*\n?/gi, '').replace(/[`*>#«»"']/g, '').trim().replace(/[.!;]+$/, '').trim().toUpperCase();
}

function quietResult(value) {
  const text = value.trimEnd();
  if (!text || quietText(text) === quietMarker) return true;
  const lines = text.split('\n');
  return quietText(lines.pop()) === quietMarker && lines.filter(line => /^\s*```/.test(line)).length % 2 === 0;
}

function providerLabel(provider) {
  if (provider === 'codex') return 'Codex';
  if (provider === 'cursor') return 'Cursor';
  return 'Claude';
}

export async function runSavedPrompt(action, plan, { signal, isCurrent, runCodexPrompt, runCursorPrompt }, env = process.env) {
  if (signal.aborted) return stopped;
  if (plan.modelError) {
    return { status: 'error', error: plan.modelError, text: plan.modelError };
  }
  const freshness = await checkSavedPromptFreshness(action, { env });
  if (!freshness.ok) {
    const message = 'источник протух: ' + freshness.path;
    return { status: 'error', error: message, text: message, stale: true };
  }

  const root = actionRoot(env);
  const name = workspaceName(plan.provider);
  const expected = path.join(await fs.realpath(root), 'autonomy', name);
  const logical = path.join(root, 'autonomy', name);
  if (await physicalRecordPath(logical) !== expected) return deferred;
  await fs.mkdir(logical, { recursive: true, mode: 0o700 });
  const cwd = await fs.realpath(logical);
  if (cwd !== expected) return deferred;
  const [denied, claudeHelpersSupported] = await Promise.all([
    protectedPaths(env, plan.provider),
    plan.provider === 'claude' && plan.tools.includes('Agent') && savedClaudeHelpersSupported(env),
  ]);
  const directories = [homeDir(env), os.tmpdir()];
  const canLaunch = async () => {
    if (signal.aborted || await fs.realpath(logical) !== cwd || !await isCurrent()) return false;
    const { state } = await loadState(env);
    return !signal.aborted && isDeepStrictEqual(
      savedPromptPlan(action, state, env, Boolean(runCodexPrompt), Boolean(runCursorPrompt)),
      plan,
    );
  };

  const timeout = AbortSignal.timeout(plan.timeoutMs);
  const turnSignal = AbortSignal.any([signal, timeout]);
  const team = savedPromptTeam(action);
  const roster = claudeHelpersSupported && team.length ? savedClaudeTeamRoster(team) : undefined;
  const teamPrompt = promptTeamInstructions(team, plan.provider, roster && [...roster.keys()]);
  const prompt = taskInstructions(action, plan, teamPrompt);
  let result;
  try {
    if (plan.provider === 'codex') {
      result = await runCodexPrompt?.({ prompt, cwd, model: plan.model, tools: plan.tools,
        directories, denied, signal: turnSignal, canLaunch }, env);
    } else if (plan.provider === 'cursor') {
      result = await runCursorPrompt?.({
        prompt, cwd, model: plan.model, continuous: plan.continuous, handoff: plan.handoff,
        shell: plan.shell, actionId: action.id, signal: turnSignal, canLaunch, timeoutMs: plan.timeoutMs,
      }, env);
    } else if (await canLaunch()) {
      const disallowedTools = ['mcp__*', 'Bash', 'Monitor', 'Skill', 'Workflow',
        ...denied.flatMap(value => ['Read', 'Edit'].map(tool => tool + '(/' + value + ')'))];
      const agents = roster ? Object.fromEntries(roster) : savedClaudeHelperRoles;
      result = await runClaudeTurn({ prompt, cwd, providerId: 'claude',
        permissionMode: 'acceptEdits', model: plan.model, autonomy: true, allowedTools: plan.tools,
        disallowedTools, isolated: { tools: plan.tools, directories,
          ...(claudeHelpersSupported ? { agents } : {}) }, signal: turnSignal });
    }
  } catch {
    if (signal.aborted) return stopped;
    return { status: 'error', error: 'не удалось запустить ' + providerLabel(plan.provider) + ' для фоновой задачи' };
  }
  if (signal.aborted) return result?.fileCommitStarted ? { ...stopped, fileCommitStarted: true } : stopped;
  if (timeout.aborted && !result) return { status: 'error', error: 'ход прерван по сроку', timeout: true };
  if (!result) return deferred;
  const usage = result.usage;
  const parentInput = usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens : undefined;
  // Old JO charged the whole observed helper total to the daily input budget.
  const knownInputs = [parentInput, result.helperTokens].filter(Number.isFinite);
  const metrics = { meteredUsd: result.meteredCostUsd, fileCommitStarted: result.fileCommitStarted,
    tokensIn: knownInputs.length ? knownInputs.reduce((total, part) => total + part, 0) : undefined,
    tokensOut: usage?.outputTokens, usageIncomplete: result.usageIncomplete };
  if (timeout.aborted) return { ...metrics, status: 'error', error: 'ход прерван по сроку', timeout: true, text: result.text };
  if (result.isError || (result.providerId && result.providerId !== plan.provider)) {
    return { ...metrics, status: 'error', error: 'ход движка не удался', text: result.assistantTextObserved ? result.text : '' };
  }
  if (plan.quiet && quietResult(result.text)) {
    return { ...metrics, status: 'skipped', detail: 'нечего сообщить — задача промолчала штатно (маркер тишины)' };
  }
  return { ...metrics, status: 'ok', text: result.text, detail: 'доставлено' };
}
