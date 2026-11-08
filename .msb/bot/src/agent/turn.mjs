import {
  hasClaudeAuth,
  NO_STATE_WRITE,
  resolveEffort,
  resolveModel,
  resolvePermMode,
  updateState,
} from '../state.mjs';
import { readClaudeVersion } from './claude-version.mjs';
import { runClaudeTurn } from './claude.mjs';
import { conversationalModePrompt } from './mode-prompt.mjs';
import { projectLocations, resolveProjectCwd } from '../projects/paths.mjs';
import { buildSystemPrompt } from './system-prompt.mjs';
import { readSessionContext } from './context.mjs';
import { claimFirstSession, releaseFirstSession } from '../../shared/session-starts.mjs';
import {applySessionResult} from './session-result.mjs';
import {captureSkillInstallTarget} from '../skills/install-target.mjs';
import {skillInstallPrompt} from '../skills/install-protocol.mjs';

/**
 * runAgentTurn: prompt/signal → выбранный CLI → результат и guarded session/usage.
 * Вызывают [Telegram](../telegram/bot.mjs) и [autonomy](../autonomy/scheduler.mjs).
 * Аргументы/stream/abort → [runClaudeTurn](./claude.mjs) → существующий PATH shim;
 * native dispatch → [provider runner](../../../../overlay/bot/ext/shim/run-turn.mjs).
 * Captured project cwd → [projects](../projects/paths.mjs); base context stays global.
 * Контекст → [system prompt](./system-prompt.mjs), [metadata](./context.mjs);
 * Skill install [target](../skills/install-target.mjs)/[protocol](../skills/install-protocol.mjs) captured with provider snapshot, final execution belongs to Telegram.
 * владелец записи сессии → [result transaction](./session-result.mjs) / [state](../state.mjs),
 * [first-start token](../../shared/session-starts.mjs), [description ledger](../sessions/ledger.mjs).
 * Проверки: [polling/session fences](../../tests/turn-lifecycle.test.mjs),
 * [provider isolation](../../../../overlay/bot/ext/tests/reference/provider-switch.test.mjs),
 * [project cwd](../../tests/project-execution.test.mjs), [project races](../../tests/project-races.test.mjs).
 */
export async function runAgentTurn({
  prompt,
  signal,
  onStatus,
  autonomy = false,
  env = process.env,
} = {}) {
  const aborted = () => ({ ok: false, error: 'aborted', text: 'Остановлено.' });
  if (signal?.aborted) return aborted();
  let state, firstSession, baseWorkspace, contextNow, skillInstall;
  await updateState(s => {
    state = { ...s };
    skillInstall=captureSkillInstallTarget(state,env);
    baseWorkspace = projectLocations(env).workspace;
    contextNow = Date.now();
    if (signal?.aborted || !hasClaudeAuth(env, s) || s.engine === 'oc' || s.ccSessionId) return NO_STATE_WRITE;
    firstSession = claimFirstSession(s);
    return firstSession ? s : NO_STATE_WRITE;
  }, env);
  try {
  if (signal?.aborted) return aborted();
  if (!hasClaudeAuth(env, state)) {
    return {
      ok: false,
      error: 'setup',
      text: 'AI ещё не подключён. Открой /start → «🔌 Подключение» или задай CLAUDE_CODE_OAUTH_TOKEN.',
    };
  }

  if (state.engine === 'oc') {
    return {
      ok: false,
      error: 'engine_oc',
      text: 'Движок OpenClaw в open-core пока не реализован. Переключись на Claude Code в настройках.',
    };
  }

  const cwd = await resolveProjectCwd(state, env, baseWorkspace);
  if (signal?.aborted) return aborted();
  const cliVersion = (state.extAuthBypass || 'claude') === 'claude' ? await readClaudeVersion(env) : undefined;
  const model = resolveModel(state);
  const effort = resolveEffort(state, cliVersion);
  const permissionMode = resolvePermMode(state, cliVersion);
  const systemPrompt = await buildSystemPrompt({ env, workspace:baseWorkspace, cwd, timezone:state.timezone || 'UTC', now:contextNow, extra: [conversationalModePrompt(state),skillInstallPrompt(skillInstall)].filter(Boolean).join('\n\n') });

  if (signal?.aborted) return aborted();

  let lastTool = '';
  const result = await runClaudeTurn({
    prompt,
    sessionId: state.ccSessionId || undefined,
    // Bind this turn to the provider observed with the session, even if the
    // menu changes the selected provider before the child process starts.
    providerId: state.extAuthBypass || 'claude',
    model,
    effort,
    permissionMode,
    systemPrompt,
    cwd,
    signal,
    autonomy,
    onEvent(ev) {
      if (ev.type === 'system' && ev.subtype === 'provider') {
        onStatus?.({ kind: 'provider', providerId: ev.provider_id });
      } else if (ev.type === 'assistant') {
        for (const part of ev.message?.content || []) {
          if (part.type === 'tool_use' && part.name) {
            lastTool = part.name;
            onStatus?.({ kind: 'tool', name: part.name, input: summarizeInput(part.input), rawInput: part.input });
          } else if (part.type === 'text' && part.text) {
            onStatus?.({ kind: 'text', preview: part.text.slice(0, 80) });
          } else if (part.type === 'thinking') {
            onStatus?.({ kind: 'thinking' });
          }
        }
      } else if (ev.type === 'system' && ev.subtype === 'init') {
        onStatus?.({ kind: 'init', model: ev.model, sessionId: ev.session_id });
      }
    },
  });

  result.context = await readSessionContext(result.sessionId, env);
  if (result.sessionId) {
    await updateState(s=>applySessionResult(s,{snapshot:state,reservation:firstSession,result,prompt,signal}),env);
  }

  if (signal?.aborted || result.aborted) {
    return { ok: false, error: 'aborted', text: 'Остановлено.', result };
  }

  const text =
    result.text ||
    (result.isError
      ? `Ход завершился с ошибкой${result.subtype ? ` (${result.subtype})` : ''}.${result.stderr ? `\n\n${result.stderr.slice(0, 500)}` : ''}`
      : lastTool
        ? `(ход без текста; последний инструмент: ${lastTool})`
        : '(пустой ответ)');

  return { ok: !result.isError, text, result, skillInstall };
  } finally {
    if (firstSession) await updateState(s => releaseFirstSession(s, firstSession) ? s : NO_STATE_WRITE, env).catch(() => {});
  }
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const file = input.file_path || input.path || input.command || input.pattern || '';
  return String(file).slice(0, 60);
}
