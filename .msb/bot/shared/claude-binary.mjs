/**
 * Resolve native Claude for overlay startup/passthrough and core metadata.
 * No shell/process/auth access. Exclude the shim by realpath, including aliases.
 * Caller: [version reader](../src/agent/claude-version.mjs); check: claude-version.
 */
import profile from './profile.cjs';
import fs from 'node:fs';
import path from 'node:path';
export function isNativeClaudeFile(file) {
  try {
    const real = fs.realpathSync(file).split(path.sep).join('/');
    if (real.endsWith('/ext/shim/bin/claude') || real.endsWith('/ext/shim/run-turn.mjs') || !fs.statSync(real).isFile()) return false;
    fs.accessSync(real, /[.](?:mjs|cjs|js)$/.test(file) ? fs.constants.R_OK : fs.constants.X_OK);
    return true;
  } catch { return false; }
}
export const nativeClaudeOverride = env => profile.envValue(env, 'MSB_REAL_CLAUDE');
export function resolveNativeClaude(env = process.env, { systemCandidates = ['/usr/bin/claude','/usr/local/bin/claude','/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'] } = {}) {
  const candidates = [nativeClaudeOverride(env), ...systemCandidates,
    ...(env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'claude'))];
  return candidates.find(file => file && isNativeClaudeFile(file)) || null;
}
