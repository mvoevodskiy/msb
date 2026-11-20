import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertChannelPaths } from '../path-guards.mjs';
import { pickCompatibleExt } from '../compat.mjs';
import { blobPath, channelIndexPath, releaseDir, storePaths } from './paths.mjs';
import { ensureDir, nowIso, readJson, sha256FileSync, writeJsonAtomic } from '../util.mjs';

export function createReleaseStore(dataDir) {
  const p = storePaths(dataDir);

  async function init() {
    await ensureDir(p.channels);
    await ensureDir(p.blobs);
    for (const ch of ['core', 'ext']) {
      await ensureDir(path.join(p.channels, ch, 'releases'));
      const idx = channelIndexPath(dataDir, ch);
      if (!(await readJson(idx, null))) {
        await writeJsonAtomic(idx, { channel: ch, latest: null, versions: [] });
      }
    }
  }

  async function getIndex(channel) {
    await init();
    return readJson(channelIndexPath(dataDir, channel), { channel, latest: null, versions: [] });
  }

  async function getRelease(channel, version) {
    const dir = releaseDir(dataDir, channel, version);
    return readJson(path.join(dir, 'manifest.json'), null);
  }

  async function listManifests(channel) {
    const idx = await getIndex(channel);
    const out = [];
    for (const v of idx.versions || []) {
      const m = await getRelease(channel, v);
      if (m) out.push(m);
    }
    return out;
  }

  async function latest(channel) {
    const idx = await getIndex(channel);
    if (!idx.latest) return null;
    return getRelease(channel, idx.latest);
  }

  async function compatibleExt(coreVersion) {
    const manifests = await listManifests('ext');
    return pickCompatibleExt(manifests, coreVersion);
  }

  async function publishFromDir({ channel, version, fromDir, compatibleCore = null, notes = '' }) {
    await init();
    if (!['core', 'ext'].includes(channel)) throw new Error('channel must be core|ext');
    if (!version || /[^\w.+\-:]/.test(version)) throw new Error('bad version');

    const files = [];
    await walkFiles(fromDir, fromDir, files);
    const mapped = files.map((abs) => {
      const rel = path.relative(fromDir, abs).split(path.sep).join('/');
      return { abs, path: normalizePublishPath(channel, rel) };
    }).filter((f) => f.path);

    if (channel === 'ext' && !mapped.length) {
      throw new Error('no ext files found — fromDir should be bot/ (run.mjs, ext/, systemd/)');
    }
    assertChannelPaths(channel, mapped);

    const manifestFiles = [];
    for (const f of mapped) {
      const sha = sha256FileSync(f.abs);
      const dest = blobPath(dataDir, sha);
      await ensureDir(path.dirname(dest));
      if (!fs.existsSync(dest)) {
        await fsp.copyFile(f.abs, dest);
      }
      const st = await fsp.stat(f.abs);
      manifestFiles.push({
        path: f.path,
        sha256: sha,
        size: st.size,
        mode: (st.mode & 0o777).toString(8).padStart(3, '0'),
      });
    }

    const manifest = {
      channel,
      version,
      created_at: nowIso(),
      notes: notes || '',
      files: manifestFiles,
    };
    if (channel === 'ext') {
      manifest.compatible_core = compatibleCore || { min: null, versions: null };
    }

    const rdir = releaseDir(dataDir, channel, version);
    await ensureDir(rdir);
    await writeJsonAtomic(path.join(rdir, 'manifest.json'), manifest);

    const idx = await getIndex(channel);
    idx.versions = [...new Set([...(idx.versions || []), version])].sort();
    idx.latest = version;
    await writeJsonAtomic(channelIndexPath(dataDir, channel), idx);
    return manifest;
  }

  function openBlob(sha256) {
    const file = blobPath(dataDir, sha256);
    if (!fs.existsSync(file)) return null;
    return file;
  }

  return { init, getIndex, getRelease, listManifests, latest, compatibleExt, publishFromDir, openBlob };
}

async function walkFiles(root, dir, out) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tests') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, abs, out);
    else if (e.isFile()) out.push(abs);
  }
}

/** fromDir может быть корнем .msb или bot/ — нормализуем к путям от LIVE_DIR */
function normalizePublishPath(channel, rel) {
  const r = rel.replace(/\\/g, '/');
  if (channel === 'ext') {
    if (r === 'bot/run.mjs' || r.startsWith('bot/ext/') || r === 'bot/systemd/60-ext-entry.conf') return r;
    if (r === 'run.mjs') return 'bot/run.mjs';
    if (r.startsWith('ext/')) return `bot/${r}`;
    if (r === 'systemd/60-ext-entry.conf') return 'bot/systemd/60-ext-entry.conf';
    return null; // index.js, package.json и пр. в ext-канал не входят
  }
  if (channel === 'core') {
    if (r === 'bot/run.mjs' || r.startsWith('bot/ext/') || r === 'bot/systemd/60-ext-entry.conf') return null;
    if (r === 'index.js') return 'bot/index.js';
    if (r === 'bot/index.js') return r;
    if (r === 'puller.cjs' || r === 'sync.cjs') return r;
    if (r.startsWith('bot/')) return r;
    if (r.startsWith('guard/') || r.startsWith('dialogue-mcp/') || r.startsWith('agent-hooks/')) return r;
    return null;
  }
  return null;
}
