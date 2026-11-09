/**
 * Scheduler-only Codex invocation. [Core policy](../../../../.msb/bot/src/autonomy/prompt-policy.mjs)
 * supplies allowed tools. [Owned process](./owned-cli.mjs) and [workspace MCP](./saved-workspace-mcp.mjs)
 * keep the native account and foreground session separate. [Local usage](./saved-codex-otlp.mjs)
 * includes scoped helper spend in the saved action journal.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBin } from './run-cli.mjs';
import { runOwnedCli } from './owned-cli.mjs';
import { parseCodexStdout } from './codex.mjs';
import { enrichPath } from '../ensure-cli.mjs';
import { loadStore } from '../store.mjs';
import { CODEX_CLI_VERSION, isValidCodexThreadId, parseCodexTomlScalars, resolveCodexEffort, resolveCodexModel } from '../codex-native.mjs';
import { CODEX_CHATGPT_BASE } from '../codex-transport.mjs';
import { savedWorkspaceToolNames } from './saved-workspace-tools.mjs';
import { openSavedCodexOtlp } from './saved-codex-otlp.mjs';
import { parseSavedCodexUsage } from './saved-codex-usage.mjs';

const bridge = fileURLToPath(new URL('./saved-workspace-mcp.mjs', import.meta.url));
const provider = 'msb_saved_prompt';
// Producers: shared/codex-mcp-profile and core mcp/launch, mcp/openclaw-setup,
// agent/openclaw-turn and media/stt. Temporary user work keeps its old scope.
const privateScratch = ['msb-mcp-', 'msb-oc-mcp-', 'msb-oc-turn-', 'msb-stt-', 'msb-saved-codex-'];
const disabled = ['shell_tool', 'shell_snapshot', 'hooks', 'plugin_hooks',
  'skill_mcp_dependency_install', 'plugins', 'remote_plugin', 'apps', 'memories', 'view_image', 'image_generation', 'goals'];

function argv({ model, effort, scope, scratch, helpers, usageArgs }, baseUrl) {
  const options = {
    model_provider: provider,
    ['model_providers.' + provider + '.name']: 'MSB saved prompt',
    ['model_providers.' + provider + '.base_url']: baseUrl,
    ['model_providers.' + provider + '.wire_api']: 'responses',
    ['model_providers.' + provider + '.requires_openai_auth']: true,
    ['model_providers.' + provider + '.supports_websockets']: false,
    web_search: scope.tools.includes('WebSearch') ? 'live' : 'disabled',
    check_for_update_on_startup: false,
    suppress_unstable_features_warning: true,
    sqlite_home: path.join(scratch, 'sqlite'),
    log_dir: path.join(scratch, 'log'),
    'features.skip_host_skill_discovery': true,
    // On the pinned CLI, V2 replaces the legacy attachment-capable helper tools.
    'features.multi_agent': helpers,
    'features.multi_agent_v2': helpers,
    'mcp_servers.saved_workspace.command': process.execPath,
    'mcp_servers.saved_workspace.args': [bridge, JSON.stringify(scope)],
    'mcp_servers.saved_workspace.required': true,
  };
  if (model) options.model = model;
  if (effort) options.model_reasoning_effort = effort;
  for (const name of disabled) options['features.' + name] = false;
  for (const name of savedWorkspaceToolNames(scope.tools)) {
    options['mcp_servers.saved_workspace.tools.' + name + '.approval_mode'] = 'approve';
  }
  return ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', '--ignore-user-config',
    '--ignore-rules', '--ephemeral', '--sandbox', 'read-only',
    ...Object.entries(options).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)]), ...usageArgs, '-'];
}

async function subscriptionAuth(native) {
  try {
    const file = await fs.realpath(path.join(native, 'auth.json'));
    const auth = JSON.parse(await fs.readFile(file, 'utf8'));
    if (auth.auth_mode === 'chatgpt' && !auth.OPENAI_API_KEY && auth.tokens?.access_token) return file;
  } catch {
    return undefined;
  }
}

async function subscriptionProfile(env) {
  const home = env.HOME || os.homedir();
  const logical = env.CODEX_HOME ?? path.join(home, '.codex');
  if (!path.isAbsolute(logical)) return;
  try {
    const native = await fs.realpath(logical);
    const authFile = await subscriptionAuth(native);
    if (!authFile) return;
    const configPath = path.join(native, 'config.toml');
    const configFile = await fs.realpath(configPath).catch(error => {
      if (error.code === 'ENOENT') return configPath;
      throw error;
    });
    const config = parseCodexTomlScalars(await fs.readFile(configFile, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    }));
    if (config.model_provider && !['openai', 'msb_http', 'iia_http'].includes(config.model_provider)) return;
    const { models, efforts } = await loadStore(env, home);
    const childEnv = { HOME: home, CODEX_HOME: native, PATH: enrichPath(env, home), LANG: env.LANG || 'C.UTF-8' };
    return { native, authFile, protectedFiles: [logical, native, authFile, configFile], config, models, efforts, childEnv };
  } catch {
    return undefined;
  }
}

export async function runSavedCodexPrompt({ cwd, prompt, model, tools, directories, denied, signal, canLaunch },
  env = process.env, { baseUrl = CODEX_CHATGPT_BASE } = {}) {
  if (signal.aborted || env.JARVIS_CC_ONLY === '1') return;
  const account = await subscriptionProfile(env);
  if (!account || signal.aborted) return;
  const { childEnv, config } = account;
  const bin = findBin('codex', childEnv);
  if (!bin || !path.isAbsolute(bin) || !await canLaunch()) return;
  const version = await runOwnedCli(bin, ['--version'], { cwd, env: childEnv,
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
  if (version.code !== 0 || version.stdout.trim() !== 'codex-cli ' + CODEX_CLI_VERSION || signal.aborted) return;
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'msb-saved-codex-')));
  let receiver;
  try {
    if (signal.aborted || !await canLaunch()) return;
    const localRuntime = [path.dirname(bridge), bin, process.execPath];
    const physicalRuntime = await Promise.all(localRuntime.map(file => fs.realpath(file)));
    if (signal.aborted || !await canLaunch()) return;
    const fileCommitMarker = path.join(scratch, 'file-commit-started');
    const scratchRoots = new Set([os.tmpdir(), path.dirname(scratch)]);
    const privatePaths = [...scratchRoots].flatMap(root => privateScratch.map(prefix => path.join(root, prefix + '*', '**')));
    const scope = { cwd, directories, denied: [...denied, ...account.protectedFiles, ...localRuntime, ...physicalRuntime, ...privatePaths],
      tools, fileCommitMarker };
    const helpers = tools.includes('Agent') && tools.includes('Task');
    if (helpers) receiver = await openSavedCodexOtlp().catch(() => undefined);
    const args = argv({ model: resolveCodexModel(undefined, config, model || account.models.codex),
      effort: account.efforts.codex || resolveCodexEffort(config), scope, scratch, helpers, usageArgs: receiver?.args ?? [] }, baseUrl);
    if (signal.aborted || !await canLaunch() || await subscriptionAuth(account.native) !== account.authFile || signal.aborted) return;
    const result = await runOwnedCli(bin, args, { cwd, env: childEnv, input: prompt, signal }).catch(error => {
      if (!signal.aborted) throw error;
      return { aborted: true, stdout: '' };
    });
    const fileCommitStarted = await fs.stat(fileCommitMarker).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    await receiver?.close();
    const parsed = parseCodexStdout(result.stdout);
    const isError = result.code !== 0 || Boolean(result.aborted || result.tooLarge) ||
      !parsed.turnCompleted || Boolean(parsed.turnFailed) || !isValidCodexThreadId(parsed.threadId);
    const nativeUsage = parseSavedCodexUsage(parsed.usage);
    const measured = receiver?.summarize(parsed.threadId, nativeUsage, !isError && !signal.aborted);
    const parent = measured?.parent ?? nativeUsage;
    const usage = parent && { inputTokens: parent.input - parent.cached, cacheReadTokens: parent.cached,
      cacheCreationTokens: 0, outputTokens: parent.output };
    return { providerId: 'codex', text: parsed.text, assistantTextObserved: Boolean(parsed.text), fileCommitStarted, isError,
      usage, helperTokens: measured?.helperTokens,
      usageIncomplete: (!parent || (helpers && (!measured || measured.incomplete))) || undefined };
  } finally {
    await receiver?.close();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
