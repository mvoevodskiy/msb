/**
 * Read-only systemd observations for the [status channel](./client.mjs)
 * and [Pult service fallback](../pult/status.mjs). No state or IPC writes.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const activeStates = new Set(['active', 'activating', 'inactive', 'failed', 'deactivating', 'reloading']);

export async function readSystemdUnitState(unit, { env = process.env, signal } = {}) {
  let output;
  let failed = false;
  try {
    const { stdout } = await exec('systemctl', [
      'show', '--no-pager', '--property=Id', '--property=LoadState', '--property=ActiveState', '--', unit,
    ], { env, signal, timeout: 1_500, maxBuffer: 8_192 });
    output = stdout;
  } catch (error) {
    if (error?.code !== 1 || typeof error.stdout !== 'string') return null;
    output = error.stdout;
    failed = true;
  }

  const fields = Object.fromEntries(output.trim().split('\n')
    .filter(line => line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (fields.Id !== unit) return null;
  if (fields.LoadState === 'not-found' && fields.ActiveState === 'inactive') return 'not-found';
  if (failed || fields.LoadState !== 'loaded' || !activeStates.has(fields.ActiveState)) return null;
  return fields.ActiveState;
}
