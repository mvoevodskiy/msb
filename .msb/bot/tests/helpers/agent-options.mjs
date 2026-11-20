/** Isolated actual runner argv/prompt probe shared by modes and effort tests. */
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('../fixtures/agent-options.mjs', import.meta.url));
export function agentOptionsProbe(provider, mode, model = 'opus', effort = 'high', cliVersion = '2.1.154', envDescription = false, envName = '', envScenario = '') {
  const child = spawnSync(process.execPath, [fixture, provider, mode, model, effort, cliVersion, envDescription ? 'env-description' : '', envName, envScenario], {
    env: { PATH: path.dirname(process.execPath), TMPDIR: os.tmpdir() }, encoding: 'utf8', timeout: 8000 });
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split('\n').find(s => s.startsWith('AGENT_OPTIONS='));
  assert.ok(line, child.stdout);
  const out = JSON.parse(line.slice('AGENT_OPTIONS='.length));
  return out;
}

export function agentOptionsReport(...args) {
  const out = agentOptionsProbe(...args);
  assert.equal(out.ok, true); assert.equal(out.calls.length, 1);
  return out;
}
