/**
 * Effective file-backed ChatGPT identity for the [saved turn](./saved-codex.mjs)
 * and its [subscription read](./saved-codex-quota.mjs). Credentials stay in the
 * native profile; comparison keys are ephemeral.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enrichPath } from '../ensure-cli.mjs';
import { parseCodexTomlScalars } from '../codex-native.mjs';

function idClaims(idToken) {
  try {
    const encoded = idToken?.split('.')[1];
    return encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) : undefined;
  } catch {
    return undefined;
  }
}

export async function readSavedCodexAccount(env = process.env) {
  const home = env.HOME || os.homedir();
  const logical = env.CODEX_HOME ?? path.join(home, '.codex');
  if (!path.isAbsolute(logical)) return;
  try {
    const native = await fs.realpath(logical);
    const authFile = await fs.realpath(path.join(native, 'auth.json'));
    const auth = JSON.parse(await fs.readFile(authFile, 'utf8'));
    const tokens = auth.tokens;
    if (auth.auth_mode !== 'chatgpt' || auth.OPENAI_API_KEY || typeof tokens?.access_token !== 'string' || !tokens.access_token) return;
    const logicalConfig = path.join(native, 'config.toml');
    const configFile = await fs.realpath(logicalConfig).catch(error => {
      if (error.code === 'ENOENT') return logicalConfig;
      throw error;
    });
    const config = parseCodexTomlScalars(await fs.readFile(configFile, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    }));
    if (config.model_provider && !['openai', 'msb_http', 'iia_http'].includes(config.model_provider)) return;
    const claims = idClaims(tokens.id_token);
    const identity = claims?.['https://api.openai.com/auth'];
    const accountId = [tokens.account_id, identity?.chatgpt_account_id].find(id => typeof id === 'string' && id.length);
    const userId = [identity?.chatgpt_user_id, identity?.user_id, claims?.sub].find(id => typeof id === 'string' && id.length);
    const credential = createHash('sha256').update(JSON.stringify([
      accountId, tokens.access_token, tokens.refresh_token, tokens.id_token,
    ])).digest('hex');
    const principal = JSON.stringify([native, accountId, accountId && userId ? userId : credential]);
    const childEnv = { HOME: home, CODEX_HOME: native, PATH: enrichPath(env, home), LANG: env.LANG || 'C.UTF-8' };
    return { home, logical, native, authFile, configFile, config, accountId, credential, principal, childEnv };
  } catch {
    return undefined;
  }
}

export function sameSavedCodexAccount(left, right) {
  if (!left || !right) return left === right;
  return left.home === right.home && left.native === right.native &&
    left.authFile === right.authFile && left.credential === right.credential;
}
