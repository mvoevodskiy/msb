#!/usr/bin/env node
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createReleaseStore } from '../src/store/releases.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

const channel = arg('channel');
const version = arg('version');
const from = arg('from');
if (!channel || !version || !from) {
  console.error('usage: publish.mjs --channel core|ext --version V --from DIR [--compatible-core-min X] [--compatible-core-versions a,b] [--notes "..."]');
  process.exit(2);
}

const config = loadConfig();
const releases = createReleaseStore(config.dataDir);
await releases.init();

let compatibleCore = null;
if (channel === 'ext') {
  const min = arg('compatible-core-min');
  const versions = arg('compatible-core-versions');
  compatibleCore = {
    min: min || null,
    versions: versions ? versions.split(',').map((s) => s.trim()).filter(Boolean) : null,
  };
}

const manifest = await releases.publishFromDir({
  channel,
  version,
  fromDir: path.resolve(from),
  compatibleCore,
  notes: arg('notes', ''),
});

console.log(JSON.stringify(manifest, null, 2));
if (flag('json')) process.exit(0);
console.error(`published ${channel}@${version} → ${config.dataDir}`);
