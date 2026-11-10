import os from 'node:os';
import { readEnvKey } from './env.mjs';
import { enrichPath } from './ensure-cli.mjs';
import { hasNativeCodexAuth } from './codex-native.mjs';
import { resolveCodexProfileDir } from '../shared/codex-profile.mjs';

/** Same auth precedence for normal Codex turns and native session commands. */
export async function codexChildEnvironment(env = process.env, home = env.HOME || os.homedir(), cwd) {
  const childEnv = { ...env, PATH: enrichPath(env, home) };
  const profileDir = resolveCodexProfileDir(cwd, childEnv, home);
  const access = await readEnvKey('CODEX_ACCESS_TOKEN', env, home);
  const apiKey = await readEnvKey('OPENAI_API_KEY', env, home);
  const native = await hasNativeCodexAuth(home, profileDir);
  if (!native && access) childEnv.CODEX_ACCESS_TOKEN = access;
  if (!native && apiKey) childEnv.OPENAI_API_KEY = apiKey;
  return { env: childEnv, profileDir, configured: Boolean(native || access || apiKey) };
}
