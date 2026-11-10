import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { detectCoreVersion, readUpdatesState, writeUpdatesState } from './core-id.mjs';
import { isCoreCompatible } from './compat.mjs';
import { msbRoot } from '../paths.mjs';
import profile from '../../shared/profile.cjs';

function cfg(env = process.env) {
  return {
    url: (profile.envValue(env, 'MSB_UPDATES_URL') || '').replace(/\/$/, ''),
    token: profile.envValue(env, 'MSB_UPDATES_TOKEN') || '',
    auto: profile.envValue(env, 'MSB_UPDATES_AUTO') === '1',
  };
}

async function api(c, pathname) {
  if (!c.url || !c.token) throw new Error('MSB_UPDATES_URL/TOKEN not set');
  const res = await fetch(`${c.url}${pathname}`, {
    headers: { authorization: `Bearer ${c.token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function downloadBlob(c, sha256) {
  const res = await fetch(`${c.url}/v1/assets/${sha256}`, {
    headers: { authorization: `Bearer ${c.token}` },
  });
  if (!res.ok) throw new Error(`asset ${sha256}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function check(env = process.env, home = env.HOME || os.homedir()) {
  const c = cfg(env);
  const core = await detectCoreVersion(home, env);
  const state = await readUpdatesState(home, env);
  const latestExt = await api(c, '/v1/channels/ext/latest');
  const compatible = core
    ? (await api(c, `/v1/channels/ext/compatible?core=${encodeURIComponent(core)}`)).release
    : latestExt.release;
  return {
    core,
    applied_ext: state.applied_ext_version,
    latest_ext: latestExt.release?.version || null,
    compatible_ext: compatible?.version || null,
    update_available: !!(compatible && compatible.version !== state.applied_ext_version),
  };
}

export async function applyExt(env = process.env, home = env.HOME || os.homedir()) {
  const c = cfg(env);
  const core = await detectCoreVersion(home, env);
  const { release } = await api(c, `/v1/channels/ext/compatible?core=${encodeURIComponent(core || '')}`);
  if (!release) throw new Error('no compatible ext');
  if (!isCoreCompatible(core, release.compatible_core) && core && !String(core).startsWith('sha256:')) {
    throw new Error('ext not compatible with core');
  }
  const live = msbRoot(home, env);
  for (const f of release.files) {
    if (f.path.includes('..')) throw new Error('bad path');
    const buf = await downloadBlob(c, f.sha256);
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    if (digest !== f.sha256) throw new Error(`hash mismatch ${f.path}`);
    const dest = path.join(live, f.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf, { mode: parseInt(f.mode || '644', 8) });
  }
  await writeUpdatesState({ applied_ext_version: release.version, applied_core_version: core }, home, env);
  return { ok: true, version: release.version };
}

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'check';
  if (cmd === 'check') {
    console.log(JSON.stringify(await check(), null, 2));
    return;
  }
  if (cmd === 'apply') {
    console.log(JSON.stringify(await applyExt(), null, 2));
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
