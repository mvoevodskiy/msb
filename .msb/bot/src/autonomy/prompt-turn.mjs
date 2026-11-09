/**
 * Execute a stateless saved prompt via [native Claude](../agent/claude.mjs) in
 * the old autonomy workspace. [Policy](./prompt-policy.mjs) supplies its tools.
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
import { physicalRecordPath } from './record-file.mjs';

const quietMarker = '[NOTHING_TO_REPORT]';
const stopped = { status: 'stopped', detail: 'ход прерван остановкой фоновых задач' };
const deferred = { status: 'deferred', detail: 'изолированный запуск сейчас недоступен' };

async function backgroundDenials(env) {
  const home = homeDir(env);
  const runtime = msbRoot(env);
  const bot = botRoot(env);
  const action = actionRoot(env);
  const paths = [path.join(home, '.ssh', '**'), path.join(home, '.scripter', '**'),
    path.join(home, '.claude', '**'), path.join(home, '.claude.json'), path.join(home, '.codex', '**'),
    path.join(runtime, '.env'), path.join(runtime, 'state.json'), path.join(runtime, 'sessions', '**'),
    path.join(runtime, 'bots', '**', '.env'), path.join(runtime, 'bots', '**', 'state.json'),
    path.join(runtime, 'bots', '**', 'ext-providers.json'), path.join(runtime, 'bots', '**', 'sessions', '**'),
    path.join(bot, '.env'), path.join(bot, 'state.json'), path.join(bot, 'ext-providers.json'),
    path.join(sessionDir(env), '**'), path.join(action, 'actions.json'), path.join(action, 'autonomy', '*.json*')];
  if (env.CLAUDE_CONFIG_DIR) paths.push(path.join(env.CLAUDE_CONFIG_DIR, '**'));
  if (env.CODEX_HOME) paths.push(path.join(env.CODEX_HOME, '**'));
  const physical = await Promise.all(paths.map(value => physicalRecordPath(path.resolve(value)).catch(() => path.resolve(value))));
  return ['mcp__*', 'Bash', 'Monitor', 'Skill', 'Workflow',
    ...[...new Set([...paths.map(value => path.resolve(value)), ...physical])].flatMap(value =>
      ['Read', 'Edit'].map(tool => `${tool}(/${value})`))];
}

function taskInstructions(action, quiet) {
  const fields = ['canWithoutApproval', 'needsApproval', 'escalateWhen', 'whatNotToDo'];
  const saved = action.authority ?? {};
  const lines = ['Твои полномочия на этом ходу (владелец записал их заранее, спросить его сейчас нельзя).',
    'Работай в рамках доступных инструментов. Результат получит владелец задачи в Telegram.'];
  const labels = ['Разрешено без согласования', 'Требует согласования', 'Когда сообщить владельцу', 'Запрещено'];
  for (const [index, field] of fields.entries()) {
    const entries = Array.isArray(saved[field]) ? saved[field].filter(value => typeof value === 'string') : [];
    if (entries.length) lines.push(labels[index] + ' — ' + entries.join(', ').slice(0, 350));
  }
  lines.push('', action.task.prompt);
  if (quiet) lines.push('', 'Если сообщать нечего — ответь одной строкой ' + quietMarker + '.');
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

export async function runSavedClaudePrompt(action, plan, { signal, isCurrent }, env = process.env) {
  if (signal.aborted) return stopped;
  const root = actionRoot(env);
  const expected = path.join(await fs.realpath(root), 'autonomy', 'cc-workspace');
  const logical = path.join(root, 'autonomy', 'cc-workspace');
  if (await physicalRecordPath(logical) !== expected) return deferred;
  await fs.mkdir(logical, { recursive: true, mode: 0o700 });
  const cwd = await fs.realpath(logical);
  if (cwd !== expected) return deferred;
  const disallowedTools = await backgroundDenials(env);
  if (await fs.realpath(logical) !== cwd || !await isCurrent()) return deferred;
  const { state } = await loadState(env);
  if (signal.aborted) return stopped;
  if (!isDeepStrictEqual(savedPromptPlan(action, state, env), plan)) return deferred;

  const timeout = AbortSignal.timeout(plan.timeoutMs);
  let result;
  try {
    result = await runClaudeTurn({ prompt: taskInstructions(action, plan.quiet), cwd, providerId: 'claude',
      permissionMode: 'acceptEdits', model: plan.model, autonomy: true, allowedTools: plan.tools,
      disallowedTools, isolated: { tools: plan.tools, directories: [homeDir(env), os.tmpdir()] },
      signal: AbortSignal.any([signal, timeout]) });
  } catch {
    if (signal.aborted) return stopped;
    return { status: 'error', error: 'не удалось запустить Claude для фоновой задачи' };
  }
  if (signal.aborted) return stopped;
  const usage = result.usage;
  const metrics = { meteredUsd: result.meteredCostUsd, tokensIn: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
    tokensOut: usage.outputTokens };
  if (timeout.aborted) return { ...metrics, status: 'error', error: 'ход прерван по сроку', timeout: true, text: result.text };
  if (result.isError || (result.providerId && result.providerId !== 'claude')) {
    return { ...metrics, status: 'error', error: 'ход движка не удался', text: result.assistantTextObserved ? result.text : '' };
  }
  if (plan.quiet && quietResult(result.text)) {
    return { ...metrics, status: 'skipped', detail: 'нечего сообщить — задача промолчала штатно (маркер тишины)' };
  }
  return { ...metrics, status: 'ok', text: result.text, detail: 'доставлено' };
}
