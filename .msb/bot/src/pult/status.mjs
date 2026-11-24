/**
 * Pult status from the helper snapshot and independent read-only service observations.
 * [Settings route](../telegram/routes/system.mjs) validates fresh outcomes;
 * [screen](../telegram/screens/system.mjs) renders this same contract.
 * The snapshot root follows [runtime profile](../../shared/profile.cjs).
 * [Checks](../../tests/pult-status.test.mjs).
 */
import path from 'node:path';
import profile from '../../shared/profile.cjs';
import { readSystemdUnitState } from '../engines/systemd-status.mjs';

export function parsePultStatus(snapshot, env = process.env) {
  const known = ['installed','enabled','active'].every(key => typeof snapshot?.[key] === 'boolean');
  const root = typeof snapshot?.root === 'string' && snapshot.root
    ? snapshot.root : path.join(profile.resolveProfile(env).root, 'pult');
  return { known, root, installed: known && snapshot.installed,
    enabled: known && snapshot.enabled, active: known && snapshot.active };
}

export async function readPultServiceStatus(options) {
  const [web, collector] = await Promise.all([
    readSystemdUnitState('pult-web.service', options),
    readSystemdUnitState('pult-collector.service', options),
  ]);
  return web || collector ? { web, collector } : null;
}
