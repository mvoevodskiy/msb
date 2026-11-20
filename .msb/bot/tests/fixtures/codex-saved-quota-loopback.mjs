/**
 * [Saved quota reader](../../../../overlay/bot/ext/adapters/saved-codex-quota.mjs)
 * through the pinned native CLI against a synthetic ChatGPT account.
 * Use the network-none Docker command in [the contract](../reference/parity-autonomy-contract.txt).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSavedCodexQuotaReader } from '../../../../overlay/bot/ext/adapters/saved-codex-quota.mjs';
import { codexQuotaRefusal } from '../../src/autonomy/subscription-gate.mjs';

const binary = process.argv[2];
assert.ok(path.isAbsolute(binary));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-native-codex-quota-check-'));
const home = path.join(root, 'home'), native = path.join(root, 'native'), bin = path.join(root, 'bin');
const auth = path.join(native, 'auth.json'), config = path.join(native, 'config.toml');
const foreign = path.join(root, 'unexpected-mcp');
const access = 'synthetic-quota-access', accountId = 'fixture-quota-account';
const idToken = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({
  sub: 'fixture-user', 'https://api.openai.com/auth': { chatgpt_account_id: accountId },
})).toString('base64url') + '.fixture';
const seconds = Math.floor(Date.now() / 1000), now = seconds * 1000;
const window = (used_percent, limit_window_seconds, reset_at) => ({ used_percent, limit_window_seconds,
  reset_after_seconds: reset_at - seconds, reset_at });
const requests = [];
let short = 69, week = 48;
const service = http.createServer((req, res) => {
  requests.push({ method: req.method, path: req.url, bound: req.headers.authorization === 'Bearer ' + access });
  if (req.method !== 'GET' || req.url !== '/backend-api/wham/usage' ||
      req.headers.authorization !== 'Bearer ' + access) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    user_id: 'quota-fixture-user', account_id: accountId, plan_type: 'plus',
    rate_limit: { allowed: true, limit_reached: false, primary_window: window(short, 18_000, seconds + 3600),
      secondary_window: window(week, 604_800, seconds + 36_000) },
    code_review_rate_limit: null, credits: null, additional_rate_limits: null,
  }));
});

try {
  await Promise.all([home, native, bin].map(dir => fs.mkdir(dir)));
  await fs.symlink(binary, path.join(bin, 'codex'));
  await fs.writeFile(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken, access_token: access,
    refresh_token: 'synthetic-quota-refresh', account_id: accountId }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
  await fs.writeFile(config, 'model = "gpt-5.4"\n[mcp_servers.fixture_foreign]\ncommand = "/bin/sh"\nargs = ["-c", ' +
    JSON.stringify('touch "' + foreign + '"') + ']\n');
  const files = [auth, config], before = await Promise.all(files.map(file => fs.readFile(file)));
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + service.address().port + '/backend-api/';
  const reader = createSavedCodexQuotaReader({
    env: { HOME: home, CODEX_HOME: native, PATH: bin + path.delimiter + process.env.PATH,
      OPENAI_API_KEY: 'ignored synthetic key' },
    baseUrl,
  });
  const state = { extAuthBypass: 'codex', timezone: 'Europe/Moscow' };
  const read = () => reader({ signal: AbortSignal.timeout(20_000), now: () => now });
  const initial = await read();
  assert.equal(await initial.isCurrent(), true);
  assert.deepEqual(initial.quota.windows, [
    { minutes: 300, usedPercent: 69, resetAtMs: now + 3_600_000 },
    { minutes: 10080, usedPercent: 48, resetAtMs: now + 36_000_000 },
  ]);
  assert.equal(codexQuotaRefusal(initial.quota, state, now, 0.3), undefined);
  assert.match(codexQuotaRefusal(initial.quota, state, now, 0.31), /подписка Codex.*69%/);
  short = 70;
  const capped = await read();
  assert.match(codexQuotaRefusal(capped.quota, state, now, 0.3), /подписка Codex.*70%/);
  week = 98;
  const weekly = await read();
  assert.match(codexQuotaRefusal(weekly.quota, state, now, 0.3), /недельный.*98%/);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), before);
  await assert.rejects(fs.stat(foreign), { code: 'ENOENT' });
  assert.equal(requests.filter(row => row.path === '/backend-api/wham/usage').length, 3);
  assert.ok(requests.every(row => row.method === 'GET' && row.bound));
  assert.ok(requests.every(row => ['/backend-api/wham/accounts/check', '/backend-api/wham/rate-limit-reset-credits',
    '/backend-api/wham/usage'].includes(row.path)));
  console.log(JSON.stringify({ version: '0.166.0', quota_reads: 3,
    native_windows_minutes: initial.quota.windows.map(row => row.minutes),
    below_short_allows: true, short_boundary_blocks: true, weekly_boundary_blocks: true, custom_reserve_boundary: true,
    auth_and_config_byte_exact: true, foreign_mcp_started: false, request_paths: [...new Set(requests.map(row => row.path))].sort(),
    production_auth: false, network: 'loopback-only' }, null, 2));
} finally {
  service.closeAllConnections();
  await new Promise(resolve => service.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
