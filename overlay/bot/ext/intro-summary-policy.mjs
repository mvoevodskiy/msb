/**
 * Read-only native Codex summary policy: resolved MCP config → temporary CLI flags.
 * [Adapter](./adapters/codex.mjs) invokes it only for [intro](../../../.msb/bot/src/agent/codex-bootstrap.mjs).
 * Config failures fail closed; flags never write the user's native configuration.
 * [Checks](./tests/intro-summary-policy.test.mjs).
 */
import path from 'node:path';
import { readCodexAppServer } from './codex-app-read.mjs';

const message = 'Не удалось безопасно подготовить подведение итогов знакомства.';
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

export async function prepareIntroductionSummary({ command, cwd, env, schemaFile, read = readCodexAppServer }) {
  if (typeof command !== 'string' || !command || typeof cwd !== 'string' || !path.isAbsolute(cwd) ||
      typeof schemaFile !== 'string' || !path.isAbsolute(schemaFile)) return { ok: false, error: message };
  let config;
  try {
    config = await read('config/read', { command, cwd, env, includeLayers: false, ownProcessGroup: false,
      appArgs: ['--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'hooks'] });
  } catch {
    return { ok: false, error: message };
  }
  const root = config?.data?.config;
  if (!config?.ok || !plainObject(root) || (root.mcp_servers !== undefined && !plainObject(root.mcp_servers))) {
    return { ok: false, error: message };
  }
  const servers = Object.keys(root.mcp_servers || {});
  const args = [
    '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin',
    '--disable', 'hooks', '--disable', 'shell_tool', '--disable', 'shell_snapshot', '--disable', 'unified_exec',
    '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'code_mode',
    '--disable', 'goals', '--disable', 'image_generation', '--disable', 'view_image', '--disable', 'memories',
    '--disable', 'multi_agent', '--disable', 'enable_mcp_apps',
    '-c', 'web_search="disabled"', '--output-schema', schemaFile,
  ];
  if (servers.length) args.push('-c', 'mcp_servers={' + servers.map(name => JSON.stringify(name) + '={enabled=false}').join(',') + '}');
  return { ok: true, args };
}
