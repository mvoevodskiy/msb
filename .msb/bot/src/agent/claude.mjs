/**
 * Запуск Claude Code CLI в режиме stream-json.
 * Контракт совместим с закрытым [msb/agent-cc] и overlay shim (PATH→claude).
 * Навигация: [Исполнение](./README.md), [provider shim](../../../../overlay/bot/ext/shim/run-turn.mjs).
 * Managed MCP launch metadata comes from [turn preparation](../mcp/launch.mjs).
 * Result provenance (spawned/sessionIdObserved) lets [session-result](./session-result.mjs)
 * count actual returned attempts without inventing history for a pre-spawn abort.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workspaceDir } from '../paths.mjs';
import { canonicalMcpPath, claudeMcpPath } from '../../shared/mcp-native-scope.mjs';

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_ALLOWED_TOOLS = 'Bash,WebSearch,WebFetch,Agent,Task,Workflow,Monitor,Skill,Read,Edit,Write,Glob,Grep';
const PROMPT_FILE_THRESHOLD = 40 * 1024;

/**
 * @typedef {object} ClaudeTurnOptions
 * @property {string} prompt
 * @property {string} [sessionId]
 * @property {string} [providerId]
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
 * @property {boolean} [autonomy]
 * @property {number} [maxTurns]
 */

/**
 * @param {ClaudeTurnOptions} opts
 */
export async function runClaudeTurn(opts) {
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
          ...process.env,
          ...opts.mcp?.env,
          MSB_TURN_MCP_TEMPLATES: opts.mcp?.codexTemplates?.join(','),
          MSB_TURN_MCP_REMOVE: opts.mcp?.codexNativeRemoval?JSON.stringify(opts.mcp.codexNativeRemoval):undefined,
          MSB_TURN_PROVIDER: opts.providerId || undefined,
          CI: '1',
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '200000',
          CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE || '90',
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
    let text = '';
    let model;
    let providerId = null;
    let subtype;
    let isError = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let costUsd;
    const toolsUsed = [];
    let toolCount = 0;

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
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
            }
            break;
          case 'assistant': {
            const msg = ev.message;
            if (msg?.usage) {
              if (typeof msg.usage.input_tokens === 'number') inputTokens = msg.usage.input_tokens;
              if (typeof msg.usage.output_tokens === 'number') outputTokens = msg.usage.output_tokens;
              cacheReadTokens = msg.usage.cache_read_input_tokens || 0;
              cacheCreationTokens = msg.usage.cache_creation_input_tokens || 0;
            }
            for (const part of msg?.content || []) {
              if (part.type === 'text' && part.text) text += part.text;
              if (part.type === 'tool_use' && part.name) {
                toolCount += 1;
                if (!toolsUsed.includes(part.name)) toolsUsed.push(part.name);
              }
            }
            break;
          }
          case 'result':
            if (Number.isFinite(ev.total_cost_usd) && ev.total_cost_usd >= 0) costUsd = ev.total_cost_usd;
            if (ev.session_id) { sessionId = ev.session_id; sessionIdObserved = true; }
            if (ev.subtype) subtype = ev.subtype;
            if (typeof ev.is_error === 'boolean') isError = ev.is_error;
            if (typeof ev.result === 'string' && ev.result && !text) text = ev.result;
            if (ev.usage) {
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
        `[msb/agent-cc] Process closed: code=${code}, signal=${signal ?? '-'}, tools=${toolCount}, stderr=${stderr.slice(0, 200)}`,
      );
      resolve({
        sessionId,
        spawned: true,
        sessionIdObserved,
        text: text.trim(),
        model,
        providerId,
        subtype,
        isError: isError || code !== 0,
        exitCode: code,
        signal,
        aborted: Boolean(opts.signal?.aborted),
        usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
        costUsd,
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
