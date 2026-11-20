#!/usr/bin/env node
import './shared/preload.mjs';
/**
 * Вход overlay: shared profile → PATH-shim → integration prepare → установленный index.js.
 * Навигация: [Обвязка](./ext/README.md), [prepare](./ext/install.mjs).
 */
import { resolveNativeClaude, isNativeClaudeFile } from './shared/claude-binary.mjs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepare } from './ext/install.mjs';
import { enrichPath } from './ext/ensure-cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shimBin = path.join(__dirname, 'ext', 'shim', 'bin');
const MARK = '[msb/ext]';

function findRealClaude() {
  const native = resolveNativeClaude();
  if (native) return native;
  const r = spawnSync('bash', ['-lc', 'type -P claude || true'], { encoding: 'utf8' });
  const found = (r.stdout || '').trim().split('\n').filter(Boolean)[0];
  if (found && isNativeClaudeFile(found)) return found;
  return null;
}

const real = findRealClaude();
if (real) {
  process.env.MSB_REAL_CLAUDE = real;
  console.error(`${MARK} real claude → ${real}`);
} else {
  console.error(`${MARK} WARNING: real claude not found — Claude provider will fail until installed`);
}

process.env.PATH = `${shimBin}${path.delimiter}${enrichPath(process.env, os.homedir())}`;
console.error(`${MARK} PATH shim → ${shimBin}`);

await prepare();

const indexUrl = pathToFileURL(path.join(__dirname, 'index.js')).href;
await import(indexUrl);
