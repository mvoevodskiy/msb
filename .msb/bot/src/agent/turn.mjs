import {
  hasClaudeAuth,
  NO_STATE_WRITE,
  resolveEffort,
  resolveModel,
  resolvePermMode,
  updateState,
} from '../state.mjs';
import { readClaudeVersion } from './claude-version.mjs';
import { claudeAutoTurnModel } from './models.mjs';
import { runClaudeTurn } from './claude.mjs';
import { readClaudeQuotaEvent, saveClaudeQuota } from './claude-quota.mjs';
import { runOpenClawTurn } from './openclaw-turn.mjs';
import { conversationalModePrompt } from './mode-prompt.mjs';
import { projectLocations, resolveProjectCwd } from '../projects/paths.mjs';
import { isLocalReminderEngine } from '../autonomy/reminder-policy.mjs';
import { openClawTaskRunPrompt, reminderPrompt } from '../autonomy/reminder-protocol.mjs';
import { buildSystemPrompt } from './system-prompt.mjs';
import { readSessionContext } from './context.mjs';
import { claimFirstSession, releaseFirstSession } from '../../shared/session-starts.mjs';
import {applySessionResult} from './session-result.mjs';
import {captureSkillInstallTarget} from '../skills/install-target.mjs';
import {skillInstallPrompt} from '../skills/install-protocol.mjs';
import {prepareMcpLaunch} from '../mcp/launch.mjs';
import {captureMcpInstallTarget} from '../mcp/managed.mjs';
import {mcpInstallPrompt} from '../mcp/install-protocol.mjs';
import {nativeMcpScope} from '../../shared/mcp-native-scope.mjs';

/**
 * runAgentTurn: prompt/signal → выбранный CLI → результат и guarded session/usage.
 * Вызывают [Telegram](../telegram/bot.mjs) и [autonomy](../autonomy/scheduler.mjs).
 * OpenClaw ordinary turn → [named acpx](./openclaw-turn.mjs), before Claude auth.
 * Аргументы/stream/abort → [runClaudeTurn](./claude.mjs) → существующий PATH shim;
 * native dispatch → [provider runner](../../../../overlay/bot/ext/shim/run-turn.mjs).
 * Captured project cwd → [projects](../projects/paths.mjs); base context stays global.
 * Контекст → [system prompt](./system-prompt.mjs), [metadata](./context.mjs).
 * Native Claude quota event → [account snapshot](./claude-quota.mjs), independent of the session result.
 * Ordinary owner turn → [reminder protocol](../autonomy/reminder-protocol.mjs) when enabled.
 * Skill install [target](../skills/install-target.mjs)/[protocol](../skills/install-protocol.mjs) captured with provider snapshot, final execution belongs to Telegram.
 * Managed MCP credentials/config → [launch](../mcp/launch.mjs); captured ADD_MCP
 * target → [Telegram installation](../telegram/install-markers.mjs).
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
  isAutoTurn = false,
  reminderOwner = 0,
  checkSavedCodex,
  env = process.env,
} = {}) {
  const aborted = () => ({ ok: false, error: 'aborted', text: 'Остановлено.' });
  if (signal?.aborted) return aborted();
  let state, firstSession, baseWorkspace, contextNow, skillInstall, mcpInstall, mcp;
  await updateState(s => {
    state = { ...s };
    skillInstall=captureSkillInstallTarget(state,env);
    if(!autonomy)mcpInstall=captureMcpInstallTarget(state,env);
    baseWorkspace = projectLocations(env).workspace;
    contextNow = Date.now();
    if (signal?.aborted || !hasClaudeAuth(env, s) || s.engine === 'oc' || s.ccSessionId) return NO_STATE_WRITE;
    firstSession = claimFirstSession(s);
    return firstSession ? s : NO_STATE_WRITE;
  }, env);
  try {
  if (signal?.aborted) return aborted();
  if(state.engine==='oc' && !autonomy){
    const cwd=await resolveProjectCwd(state,env,baseWorkspace);
    if(signal?.aborted)return aborted();
    const reminderRail = reminderOwner && !isAutoTurn ? 'oc' : undefined;
    const runHistory = reminderRail ? await openClawTaskRunPrompt(state, env) : '';
    const extra = [skillInstallPrompt(skillInstall), runHistory].filter(Boolean).join('\n\n');
    const systemPrompt=await buildSystemPrompt({env,workspace:baseWorkspace,cwd,timezone:state.timezone || 'UTC',
      now:contextNow,extra});
    const result=await runOpenClawTurn({state,prompt,systemPrompt,cwd,env,signal,onStatus});
    return {...result,skillInstall,...(reminderRail ? {reminderRail} : {})};
  }
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
  const providerId = state.extAuthBypass || 'claude';
  const cliVersion = providerId === 'claude' ? await readClaudeVersion(env) : undefined;
  const selectedModel = resolveModel(state);
  const model = isAutoTurn && providerId === 'claude'
    ? claudeAutoTurnModel(selectedModel, state.ccModel || state.model, env)
    : selectedModel;
  const effort = resolveEffort(model === selectedModel ? state : { ...state, ccModel: model }, cliVersion);
  const permissionMode = resolvePermMode(state, cliVersion);
  const extra = [conversationalModePrompt(state), skillInstallPrompt(skillInstall), mcpInstallPrompt(mcpInstall)];
  const reminderRail = reminderOwner && !autonomy && !isAutoTurn && isLocalReminderEngine(state.engine);
  if (reminderRail) extra.push(await reminderPrompt(state, reminderOwner, env, checkSavedCodex));
  const systemPrompt = await buildSystemPrompt({ env, workspace: baseWorkspace, cwd, timezone: state.timezone || 'UTC',
    now: contextNow, extra: extra.filter(Boolean).join('\n\n') });

  if (signal?.aborted) return aborted();
  mcp=await prepareMcpLaunch(state,providerId,env,cwd);
  const installScope=mcpInstall?await nativeMcpScope(mcpInstall.provider,cwd,env):undefined;
  if (signal?.aborted) return aborted();

  let lastTool = '';
  let streamProvider = providerId, quotaWrite;
  const result = await runClaudeTurn({
    prompt,
    sessionId: state.ccSessionId || undefined,
    // Bind this turn to the provider observed with the session, even if the
    // menu changes the selected provider before the child process starts.
    providerId,
    mcp,
    model,
    effort,
    permissionMode,
    systemPrompt,
    cwd,
    signal,
    autonomy,
    onEvent(ev) {
      if (ev.type === 'system' && typeof ev.provider_id === 'string') streamProvider = ev.provider_id;
      if (ev.type === 'system' && ev.subtype === 'provider') {
        onStatus?.({ kind: 'provider', providerId: ev.provider_id });
      } else if (ev.type === 'rate_limit_event' && providerId === 'claude' && streamProvider === 'claude') {
        const quota = readClaudeQuotaEvent(ev);
        if (quota) quotaWrite = saveClaudeQuota(quota, state, env, signal)
          .catch(() => console.error('[msb/agent-cc] Could not save the Claude quota snapshot'));
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

  if (quotaWrite) await quotaWrite;
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

  // Error diagnostics can contain arbitrary text. A partial error is eligible
  // only when the CLI returned actual assistant text.
  const canInstallMcp=result.text && (!result.isError || (providerId==='claude' && result.assistantTextObserved));
  return { ok: !result.isError, text, result, skillInstall,
    mcpInstall:canInstallMcp && mcpInstall?{...mcpInstall,cwd,nativeScope:installScope}:null,
    ...(reminderRail ? { reminderRail: 'cc' } : {}),
  };
  } finally {
    await mcp?.close?.();
    if (firstSession) await updateState(s => releaseFirstSession(s, firstSession) ? s : NO_STATE_WRITE, env).catch(() => {});
  }
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const file = input.file_path || input.path || input.command || input.pattern || '';
  return String(file).slice(0, 60);
}
