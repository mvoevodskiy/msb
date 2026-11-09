import { readClaudeVersion } from './claude-version.mjs';
import { runClaudeTurn } from './claude.mjs';
import { resolveEffort, resolveModel, resolvePermMode } from '../state.mjs';
import {workspaceDir} from '../paths.mjs';
import {claudeNativeScope} from '../mcp/native-removal.mjs';

/**
 * Route the old Telegram action to a verified provider implementation.
 * Keep [native MCP removals](../mcp/native-removal.mjs) active for the compact launch.
 */
export async function compactSession(state, { signal, isCurrent = async () => true,
  compactProvider, runClaude = runClaudeTurn, readVersion = readClaudeVersion } = {}) {
  if (state.engine === 'oc') return { ok: false, error: 'Сжатие OpenClaw в этом ядре пока не подключено.' };
  if (typeof state.ccSessionId !== 'string' || !state.ccSessionId.trim()) {
    return { ok: false, error: 'Нет активной CC-сессии. Напиши что-нибудь сначала.' };
  }
  const provider = state.extAuthBypass || 'claude';
  if (provider === 'codex') {
    if (!compactProvider) return { ok: false, error: 'Сжатие Codex пока не подключено.' };
    return compactProvider(state, { signal, isCurrent });
  }
  if (provider !== 'claude') return { ok: false, error: `Сжатие для ${provider} пока не подключено.` };
  if (state.ccSessionId.startsWith('ext:')) return { ok: false, error: 'Текущая сессия не принадлежит Claude.' };
  if (signal?.aborted || !await isCurrent()) return { ok: false, aborted: true };

  const version = await readVersion();
  const removal=state.removedNativeMcp?.claude
    ? await claudeNativeScope(state,workspaceDir(),process.env) : null;
  if (signal?.aborted || !await isCurrent()) return { ok: false, aborted: true };
  let boundary = false;
  const result = await runClaude({
    prompt: '/compact', sessionId: state.ccSessionId, providerId: 'claude',
    ...(removal?{mcp:{claudeMcpScope:removal.scope,claudeDeniedMcp:removal.denied}}:{}),
    model: resolveModel(state), effort: resolveEffort(state,version), permissionMode: resolvePermMode(state,version), signal, maxTurns: 1,
    disallowedTools: ['Bash', 'WebSearch', 'WebFetch', 'Agent', 'Task', 'Workflow', 'Monitor', 'Skill', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
    onEvent: (event) => { if (event.type === 'system' && event.subtype === 'compact_boundary') boundary = true; },
  });
  if (signal?.aborted || result.aborted) return { ok: false, aborted: true };
  if (result.sessionId && result.sessionId !== state.ccSessionId) return { ok: false, error: 'Claude вернул другую сессию.' };
  if (result.isError) return { ok: false, error: 'Claude не завершил сжатие.' };
  if (!boundary) {
    // master /compact treated a successful CLI without a boundary as a no-op.
    const usage = result.usage;
    const tokens = usage && Number.isFinite(usage.inputTokens)
      ? usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheCreationTokens || 0) : null;
    const size = tokens >= 1000 ? `~${Math.round(tokens / 1000)}K` : `~${tokens}`;
    const text = tokens > 0
      ? `Сжимать нечего — контекст не забит: сейчас в нём ${size} токенов. Компакт нужен, когда история большая.`
      : 'Сжимать пока нечего — история короткая. Контекст не забит, можно продолжать.';
    return { ok: true, compacted: false, text };
  }
  return { ok: true };
}
