/**
 * Pure helper→Pult status adapter: missing/partial data is not installed=false.
 * [Settings route](../telegram/routes/system.mjs) validates fresh outcomes;
 * [screen](../telegram/screens/system.mjs) renders this same contract.
 * Root follows [runtime profile](../../shared/profile.cjs), no filesystem probing.
 * [Checks](../../tests/pult-status.test.mjs).
 */
import path from 'node:path';
import profile from '../../shared/profile.cjs';

export function parsePultStatus(snapshot, env = process.env) {
  const known = ['installed','enabled','active'].every(key => typeof snapshot?.[key] === 'boolean');
  const root = typeof snapshot?.root === 'string' && snapshot.root
    ? snapshot.root : path.join(profile.resolveProfile(env).root, 'pult');
  return { known, root, installed: known && snapshot.installed,
    enabled: known && snapshot.enabled, active: known && snapshot.active };
}
