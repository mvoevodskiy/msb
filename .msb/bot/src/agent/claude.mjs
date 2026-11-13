/**
 * Запуск Claude Code CLI в режиме stream-json.
 * Контракт совместим с закрытым [msb/agent-cc] и overlay shim (PATH→claude).
 * Навигация: [Исполнение](./README.md), [provider shim](../../../../overlay/bot/ext/shim/run-turn.mjs).
 * Managed MCP launch metadata comes from [turn preparation](../mcp/launch.mjs).
 * Native total_cost_usd is CLI metering; paid spend belongs to a verified billing source.
 * Terminal helper usage feeds [saved prompt accounting](../autonomy/prompt-turn.mjs).
 * Result provenance (spawned/sessionIdObserved) lets [session-result](./session-result.mjs)
 * count returned attempts separately from pre-spawn aborts. The Codex shim can
 * supply a provisional thread before the process group is stopped.
 * Pre-execution Claude resume refusal is consumed by [turn](./turn.mjs).
 * [Resume recovery checks](../../tests/claude-resume-recovery.test.mjs).
 * Native context input and compact threshold → [Claude context](./claude-context.mjs).
 * The pre-abort assistant reply is frozen before signalling the CLI group.
 * [Telegram stop checks](../../tests/turn-lifecycle.test.mjs).
 * Native API error frames stay separate from the assistant and its usage.
 * [Partial error checks](../../tests/claude-partial-error.test.mjs).
 * [Native-shim regression](../../../../overlay/bot/ext/tests/reference/provider-switch.test.mjs).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceDir } from '../paths.mjs';
import { canonicalMcpPath, claudeMcpPath } from '../../shared/mcp-native-scope.mjs';
import { isProviderSession } from '../../shared/session-starts.mjs';
import { claudeCompactSettings, claudeTurnContext, updateClaudeInputSample } from './claude-context.mjs';

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_ALLOWED_TOOLS = 'Bash,WebSearch,WebFetch,Agent,Task,Workflow,Monitor,Skill,Read,Edit,Write,Glob,Grep';
const PROMPT_FILE_THRESHOLD = 40 * 1024;

function isolatedEnvironment() {
  const env = { ...process.env };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MSB_ANTHROPIC_API_KEY',
    'IIA_ANTHROPIC_API_KEY', 'BOT_TOKEN', 'SYNC_KEY', 'SYNC_URL']) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key.startsWith('NPM_CONFIG_')) delete env[key];
  }
  return env;
}

/**
 * @typedef {object} ClaudeTurnOptions
 * @property {string} prompt
 * @property {string} [sessionId]
 * @property {string} [providerId]
 * @property {{ HOME: string, CODEX_HOME?: string }} [codexProfile] The profile used by [context](./context.mjs).
 * @property {boolean} [codexBootstrap] Keep the Codex ID outside the ordinary provider store.
 * @property {boolean} [codexIntroSummary] Resume only for a read-only structured introduction summary.
 * @property {object} [mcp]
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [permissionMode]
 * @property {string} [systemPrompt]
 * @property {string[]} [allowedTools]
 * @property {string[]} [disallowedTools]
 * @property {AbortSignal} [signal]
 * @property {string} [cwd]
 * @property {(ev: object) => void} [onEvent]
 * @property {() => void} [onSpawn] Called after the CLI child actually starts.
 * @property {boolean} [autonomy]
 * @property {number} [maxTurns]
 * @property {{tools: string[], directories: string[], agents?: Record<string, {description: string, prompt: string}>}} [isolated]
 */

/**
 * @param {ClaudeTurnOptions} opts
 */
export async function runClaudeTurn(opts) {
  if (opts.isolated && (opts.sessionId || opts.mcp || opts.providerId !== 'claude')) {
    throw new Error('Invalid isolated Claude launch');
  }
  if (opts.codexIntroSummary && (!opts.codexBootstrap || opts.providerId !== 'codex' ||
      !isProviderSession(opts.sessionId, 'codex') || opts.mcp)) {
    throw new Error('Invalid Codex introduction summary launch');
  }
  const cwd = opts.cwd || workspaceDir();
  const permissionMode = opts.permissionMode || 'bypassPermissions';
  const maxTurns = Number.isInteger(opts.maxTurns) && opts.maxTurns > 0
    ? opts.maxTurns : (opts.autonomy ? 50 : DEFAULT_MAX_TURNS);

  const allowed =
    opts.allowedTools?.length > 0
      ? opts.allowedTools.join(',')
      : [DEFAULT_ALLOWED_TOOLS, ...(opts.mcp?.claudeAllowedTools ?? [])].join(',');

  /** @type {string[]} */
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(maxTurns),
    '--permission-mode',
    permissionMode,
    '--allowedTools',
    allowed,
  ];

  if (opts.isolated) {
    args.push('--tools', opts.isolated.tools.join(','), '--no-session-persistence', '--no-chrome',
      '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', JSON.stringify({ disableAllHooks: true, disableClaudeAiConnectors: true }),
      '--add-dir', ...opts.isolated.directories);
    if (opts.isolated.agents) args.push('--agents', JSON.stringify(opts.isolated.agents));
  }

  const denied = [
    ...(opts.disallowedTools || []),
    // зеркало Dn(): не трогать секреты/ядро через tools без явного override
  ];
  if (denied.length) {
    args.push('--disallowedTools', ...denied);
  }

  let sysPromptFile = null;
  if (opts.systemPrompt) {
    const bytes = Buffer.byteLength(opts.systemPrompt, 'utf8');
    if (bytes > PROMPT_FILE_THRESHOLD) {
      sysPromptFile = path.join(
        os.tmpdir(),
        `msb-cc-system-prompt-${process.pid}-${Date.now().toString(36)}.md`,
      );
      await fs.writeFile(sysPromptFile, opts.systemPrompt, { mode: 0o600 });
      args.push('--append-system-prompt-file', sysPromptFile);
    } else {
      args.push('--append-system-prompt', opts.systemPrompt);
    }
  }

  if (opts.mcp?.claudeConfig) args.push('--mcp-config', opts.mcp.claudeConfig);
  if (opts.mcp?.claudeDeniedMcp?.length) {
    const deniedMcpServers=opts.mcp.claudeDeniedMcp.map(serverName=>({serverName}));
    args.push('--settings',JSON.stringify({deniedMcpServers}));
  }
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.sessionId) args.push('--resume', opts.sessionId);

  const claudeResume = opts.providerId === 'claude' && isProviderSession(opts.sessionId, 'claude');
  const compact = opts.providerId === 'claude' && !opts.isolated ? claudeCompactSettings(opts.model, process.env) : null;
  const promptBytes = Buffer.byteLength(opts.prompt || '', 'utf8');
  if (promptBytes > 9 * 1024 * 1024) {
    throw new Error(`MESSAGE_TOO_LARGE:${(promptBytes / 1024 / 1024).toFixed(1)}`);
  }

  const mcpScope = opts.mcp?.claudeMcpScope;
  const scopeChanged = mcpScope && await canonicalMcpPath(claudeMcpPath(cwd, process.env)) !== mcpScope;
  if (opts.signal?.aborted) {
    if (sysPromptFile) await fs.unlink(sysPromptFile).catch(() => {});
    return {
      sessionId: opts.sessionId || '', spawned: false, sessionIdObserved: false, text: '', isError: false,
      exitCode: null, signal: null, aborted: true,
      usage: { inputTokens: 0, outputTokens: 0 }, toolsUsed: [], toolCount: 0, stderr: '',
    };
  }

  if (scopeChanged) {
    if (sysPromptFile) await fs.unlink(sysPromptFile).catch(() => {});
    throw new Error('Профиль Claude изменился при подготовке MCP.');
  }

  console.error(
    `[msb/agent-cc] Spawning: claude ${args.slice(0, 3).join(' ')}... (session=${(opts.sessionId || 'new').slice(0, 8)}, model=${opts.model || 'default'}, prompt=${promptBytes}B)`,
  );

  return new Promise((resolve, reject) => {
    let child;
    let closed = false;
    let abortStarted = false;
    let termTimer = null;
    let killTimer = null;
    try {
      child = spawn('claude', args, {
        cwd,
        env: {
          ...(opts.isolated ? isolatedEnvironment() : process.env),
          ...opts.mcp?.env,
          ...opts.codexProfile,
          MSB_TURN_MCP_TEMPLATES: opts.mcp?.codexTemplates?.join(','),
          MSB_TURN_MCP_REMOVE: opts.mcp?.codexNativeRemoval?JSON.stringify(opts.mcp.codexNativeRemoval):undefined,
          MSB_TURN_MCP_CUSTOM: opts.mcp?.codexCustom?JSON.stringify(opts.mcp.codexCustom):undefined,
          MSB_TURN_PROVIDER: opts.providerId || undefined,
          MSB_CODEX_BOOTSTRAP: opts.codexBootstrap ? '1' : undefined,
          MSB_CODEX_INTRO_SUMMARY: opts.codexIntroSummary ? '1' : undefined,
          MSB_CODEX_INTRO_SCHEMA: opts.codexIntroSummary
            ? fileURLToPath(new URL('./intro-summary.schema.json', import.meta.url)) : undefined,
          CI: '1',
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: compact?.window ?? (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '200000'),
          CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: compact?.percent ?? (process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE || '90'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      cleanup();
      if (err?.code === 'ENOENT') {
        return reject(new Error('Claude Code CLI не установлен'));
      }
      return reject(err);
    }

    child.once('spawn', () => {
      try { opts.onSpawn?.(); } catch { console.error('[msb/agent-cc] spawn observer failed'); }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.prompt || '');

    function signalGroup(signal) {
      if (closed) return false;
      // The detached CLI owns this process group, including its shim/tools.
      // Do not test child.killed: it only means a signal was sent. Nor does
      // leader exit imply close: descendants can still hold inherited pipes.
      if (child?.pid) {
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch {
          // A missing group may occur before spawn finishes. Fall back only
          // while the original child is still alive, never to a reaped PID.
        }
      }
      if (child && child.exitCode == null && child.signalCode == null) {
        try { return child.kill(signal); } catch { /* already gone */ }
      }
      return false;
    }

    function onAbort() {
      if (closed || abortStarted) return;
      abortStarted = true;
      stoppedReply = captureClaudeReply(currentClaudeContext());
      if (!signalGroup('SIGINT') || closed) return;
      termTimer = setTimeout(() => {
        termTimer = null;
        if (!signalGroup('SIGTERM') || closed) return;
        killTimer = setTimeout(() => {
          killTimer = null;
          signalGroup('SIGKILL');
        }, 5000);
        killTimer.unref?.();
      }, 3000);
      termTimer.unref?.();
    }
    let stdoutBuf = '';
    let stderr = '';
    let sessionId = opts.sessionId || '';
    let sessionIdObserved = false;
    let startedCodexSessionId = '';
    let text = '';
    let assistantObserved = false;
    let assistantTextObserved = false;
    let assistantTextOffset = 0;
    let stoppedReply;
    let structuredResumeRefusal = false;
    let model;
    let providerId = null;
    let subtype;
    let errorDisplay;
    let apiErrorText = '';
    let isError = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let reportedCostUsd;
    const latestInput = {};
    let terminalUsage;
    const helperTasks = opts.isolated?.agents ? new Set() : null;
    let helperTokens = 0;
    const toolsUsed = [];
    let toolCount = 0;

    function currentClaudeContext() {
      return compact && (!providerId || providerId === 'claude')
        ? claudeTurnContext(compact.threshold, latestInput, terminalUsage) : null;
    }

    function captureClaudeReply(context) {
      if (!compact || (providerId && providerId !== 'claude') || !assistantTextObserved) return null;
      // A terminal fallback may precede the first assistant block. Only the
      // parsed assistant suffix belonged to the old streaming renderer.
      const assistantText = text.slice(assistantTextOffset).trim();
      return assistantText ? { text: assistantText, context } : null;
    }

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    // One JSONL record can span chunks, including a split UTF-8 character.
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const ev = parseStreamLine(line);
        if (!ev) continue;
        opts.onEvent?.(ev);
        switch (ev.type) {
          case 'system':
            if (['claude', 'codex', 'cursor', 'qwen'].includes(ev.provider_id)) providerId = ev.provider_id;
            if (ev.subtype === 'init') {
              if (!providerId && ev.apiKeySource !== 'ext') providerId = 'claude';
              if (ev.session_id) { sessionId = ev.session_id; sessionIdObserved = true; }
              if (ev.model) model = ev.model;
            } else if (ev.subtype === 'codex_thread_started' && opts.providerId === 'codex' &&
                ev.provider_id === 'codex' && isProviderSession(ev.session_id, 'codex')) {
              startedCodexSessionId ||= ev.session_id;
            } else if (helperTasks && ev.subtype === 'task_notification') {
              const taskId = ev.task_id;
              const tokens = ev.usage?.total_tokens;
              if (typeof taskId === 'string' && taskId && !helperTasks.has(taskId) &&
                  Number.isSafeInteger(tokens) && tokens >= 0) {
                helperTasks.add(taskId);
                helperTokens += tokens;
              }
            }
            break;
          case 'assistant': {
            assistantObserved = true;
            const msg = ev.message;
            // Native Claude 2.1.316 sends API errors as marked assistant frames.
            if (compact && (!providerId || providerId === 'claude') && ev.is_api_error_message === true) {
              apiErrorText = (msg?.content || []).filter(part => part.type === 'text')
                .map(part => part.text).join('').trim() || apiErrorText;
              break;
            }
            if (msg?.usage) {
              if (compact) updateClaudeInputSample(latestInput, msg.usage);
              if (typeof msg.usage.input_tokens === 'number') inputTokens = msg.usage.input_tokens;
              if (typeof msg.usage.output_tokens === 'number') outputTokens = msg.usage.output_tokens;
              cacheReadTokens = msg.usage.cache_read_input_tokens || 0;
              cacheCreationTokens = msg.usage.cache_creation_input_tokens || 0;
            }
            for (const part of msg?.content || []) {
              if (part.type === 'text' && part.text) {
                if (!assistantTextObserved) assistantTextOffset = text.length;
                text += part.text;
                assistantTextObserved = true;
              }
              if (part.type === 'tool_use' && part.name) {
                toolCount += 1;
                if (!toolsUsed.includes(part.name)) toolsUsed.push(part.name);
              }
            }
            break;
          }
          case 'result':
            if (Number.isFinite(ev.total_cost_usd) && ev.total_cost_usd >= 0) reportedCostUsd = ev.total_cost_usd;
            if (ev.session_id) { sessionId = ev.session_id; sessionIdObserved = true; }
            if (ev.subtype) subtype = ev.subtype;
            if (opts.providerId === 'codex' && providerId === 'codex' && ev.subtype === 'error_draft' &&
                typeof ev.error_display?.before === 'string' && typeof ev.error_display?.after === 'string') {
              errorDisplay = ev.error_display;
            }
            if (typeof ev.is_error === 'boolean') isError = ev.is_error;
            if (claudeResume && ev.is_error === true && Array.isArray(ev.errors)) {
              structuredResumeRefusal ||= ev.errors.some(isClaudeResumeRefusal);
            }
            if (typeof ev.result === 'string' && ev.result && !text) text = ev.result;
            if (ev.usage) {
              if (compact) terminalUsage = ev.usage;
              if (typeof ev.usage.input_tokens === 'number') inputTokens = ev.usage.input_tokens;
              if (typeof ev.usage.output_tokens === 'number') outputTokens = ev.usage.output_tokens;
              cacheReadTokens = ev.usage.cache_read_input_tokens || 0;
              cacheCreationTokens = ev.usage.cache_creation_input_tokens || 0;
            }
            break;
          default:
            break;
        }
      }
    });

    child.on('error', (err) => {
      cleanup();
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code, signal) => {
      cleanup();
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      console.error(
        `[msb/agent-cc] Process closed: code=${code}, signal=${signal ?? '-'}, tools=${toolCount}, stderr=${opts.isolated ? '[background]' : stderr.slice(0, 200)}`,
      );
      const aborted = Boolean(opts.signal?.aborted);
      // The native rejection can echo the requested ID as its result session.
      // Only an error before assistant/model activity can retry the input.
      const resumeRejected = claudeResume && !aborted && code !== null && (isError || code !== 0) &&
        (!providerId || providerId === 'claude') && !assistantObserved &&
        inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0 &&
        (structuredResumeRefusal || stderr.split(/\r?\n/).some(isClaudeResumeRefusal));
      if (aborted && !sessionId && startedCodexSessionId) {
        sessionId = startedCodexSessionId;
        sessionIdObserved = true;
      }
      const context = currentClaudeContext();
      const assistantReply = aborted ? stoppedReply : captureClaudeReply(context);
      const failed = isError || code !== 0;
      if (!aborted && failed && assistantReply && apiErrorText) {
        errorDisplay = { before: '', after: '\n\n' + apiErrorText };
      }
      resolve({
        sessionId,
        ...(context ? { context } : {}),
        ...(assistantReply ? { assistantReply } : {}),
        spawned: true,
        sessionIdObserved,
        text: text.trim() || apiErrorText,
        assistantTextObserved,
        ...(resumeRejected ? { resumeRejected } : {}),
        model,
        providerId,
        subtype,
        ...(errorDisplay ? { errorDisplay } : {}),
        isError: failed,
        exitCode: code,
        signal,
        aborted,
        usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
        ...(helperTasks?.size ? { helperTokens } : {}),
        // Alternate stream adapters supply a compatibility zero, not a meter.
        meteredCostUsd: (!opts.providerId || opts.providerId === 'claude') &&
          (!providerId || providerId === 'claude') ? reportedCostUsd : undefined,
        toolsUsed,
        toolCount,
        stderr: stderr.slice(0, 4000),
      });
    });

    // Register terminal handlers first: an already-aborted signal (or a mock
    // child that closes synchronously on kill) must still settle this turn.
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    function cleanup() {
      closed = true;
      if (termTimer !== null) clearTimeout(termTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      termTimer = killTimer = null;
      if (sysPromptFile) fs.unlink(sysPromptFile).catch(() => {});
    }
  });
}

// Old qTA, blob 73aa9e7e at 55986–55988. Only terminal diagnostics call this.
function isClaudeResumeRefusal(message) {
  if (typeof message !== 'string') return false;
  const text = message.toLowerCase();
  return text.includes('no conversation found') || text.includes('cannot resume') ||
    (text.includes('session') && (text.includes('not found') || text.includes('incompatible')));
}

function parseStreamLine(line) {
  const A = line.trim();
  if (!A) return null;
  try {
    const Q = JSON.parse(A);
    if (Q && typeof Q.type === 'string') return Q;
    console.error(`[msb/agent-cc] stream-json line without 'type' field: ${A.slice(0, 200)}`);
    return null;
  } catch (err) {
    console.error(`[msb/agent-cc] stream-json parse failed (${err.message}): ${A.slice(0, 200)}`);
    return null;
  }
}
