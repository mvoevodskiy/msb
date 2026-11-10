/**
 * One read-only native quota probe for the [saved scheduler](../../../../.msb/bot/src/autonomy/reminder-dispatch.mjs).
 * Uses the same [effective account](./saved-codex-account.mjs) as the saved turn,
 * with no new thread and no use of the Pult display cache.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCodexAppServer } from '../codex-app-read.mjs';
import { CODEX_CLI_VERSION } from '../codex-native.mjs';
import { CODEX_CHATGPT_BASE } from '../codex-transport.mjs';
import { findBin } from './run-cli.mjs';
import { runOwnedCli } from './owned-cli.mjs';
import { readSavedCodexAccount, sameSavedCodexAccount } from './saved-codex-account.mjs';

const backend = new URL('../', CODEX_CHATGPT_BASE + '/').href;
const rateLimitTypes = new Set(['rate_limit_reached', 'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted', 'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached']);

function readWindow(window) {
  const usedPercent = window?.usedPercent, minutes = window?.windowDurationMins;
  const seconds = window?.resetsAt;
  if (Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100 &&
      [300, 10080].includes(minutes) && Number.isSafeInteger(seconds) && seconds > 0 &&
      Number.isFinite(new Date(seconds * 1000).getTime())) return { usedPercent, minutes, resetAtMs: seconds * 1000 };
}

function scopedQuota(raw, account, measuredAt) {
  if (!raw || (raw.accountId != null && raw.accountId !== account.accountId)) return;
  const reported = raw.rateLimitsByLimitId?.codex ?? raw.rateLimits;
  const scope = reported?.limitId == null || reported.limitId === 'codex' ? reported : undefined;
  const windows = [readWindow(scope?.primary), readWindow(scope?.secondary)].filter(Boolean);
  return {
    measuredAt, windows,
    ordinaryAllowed: raw.accountId && raw.accountId === account.accountId ? raw.ordinaryUsageAllowed : undefined,
    spendControlReached: scope?.spendControlReached === true,
    rateLimitReached: rateLimitTypes.has(scope?.rateLimitReachedType),
  };
}

async function readNativeQuota(account, baseUrl, signal, isCurrent) {
  const command = findBin('codex', account.childEnv);
  if (!command || !path.isAbsolute(command) || signal.aborted) return;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-saved-codex-quota-'));
  try {
    const version = await runOwnedCli(command, ['--version'], { cwd: scratch, env: account.childEnv,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (version.code !== 0 || version.stdout.trim() !== 'codex-cli ' + CODEX_CLI_VERSION ||
        signal.aborted || !await isCurrent() || signal.aborted) return;
    const options = {
      chatgpt_base_url: baseUrl,
      cli_auth_credentials_store: 'file',
      'features.apps': false,
      'features.plugins': false,
      'features.remote_plugin': false,
      'features.hooks': false,
      'analytics.enabled': false,
      'otel.exporter': 'none',
      'otel.metrics_exporter': 'none',
      'otel.trace_exporter': 'none',
      check_for_update_on_startup: false,
      sqlite_home: path.join(scratch, 'sqlite'),
      log_dir: path.join(scratch, 'log'),
    };
    const appArgs = Object.entries(options).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)]);
    const result = await readCodexAppServer('account/rateLimits/read', { command, cwd: scratch,
      env: account.childEnv, signal, appArgs });
    return result.ok ? result.data : undefined;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

export function createSavedCodexQuotaReader({ env = process.env, baseUrl = backend } = {}) {
  // The provider's explicit denial survives an unavailable read for this
  // scheduler and principal. A fresh true is needed to clear it.
  const deniedPrincipals = new Set();
  return async ({ signal, now = Date.now }) => {
    const account = await readSavedCodexAccount(env);
    const isCurrent = async () => sameSavedCodexAccount(account, await readSavedCodexAccount(env));
    if (!account || signal.aborted) return { isCurrent };
    const raw = await readNativeQuota(account, baseUrl, signal, isCurrent).catch(() => undefined);
    if (signal.aborted || !await isCurrent()) return { isCurrent };
    const measured = scopedQuota(raw, account, now());
    if (measured?.ordinaryAllowed === false) deniedPrincipals.add(account.principal);
    else if (measured?.ordinaryAllowed === true) deniedPrincipals.delete(account.principal);
    const ordinaryDenied = deniedPrincipals.has(account.principal);
    return { isCurrent, quota: measured || ordinaryDenied ? { ...measured, ordinaryDenied } : undefined };
  };
}
