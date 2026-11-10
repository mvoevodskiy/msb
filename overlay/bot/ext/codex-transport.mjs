/**
 * Обход известного сбоя Responses WebSocket у Codex CLI:
 * "websocket closed by server before response.completed" / Reconnecting 5/5.
 *
 * Встроенный provider `openai` нельзя отключить от WS, поэтому заводим
 * кастомный HTTP-only provider и направляем bot-ходы на него.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexAuthPath, codexHome, parseCodexTomlScalars } from './codex-native.mjs';
import profile from '../shared/profile.cjs';
import { withCodexConfig } from './codex-config-write.mjs';

export const MSB_HTTP_PROVIDER_ID = 'msb_http';

export const CODEX_CHATGPT_BASE = 'https://chatgpt.com/backend-api/codex';
const API_BASE = 'https://api.openai.com/v1';

async function detectAuthMode(home) {
  try {
    const data = JSON.parse(await fs.readFile(codexAuthPath(home), 'utf8'));
    if (data?.auth_mode === 'api_key' || data?.OPENAI_API_KEY) return 'api';
    if (data?.tokens || data?.auth_mode === 'chatgpt' || data?.auth_mode === 'AccessToken') {
      return 'chatgpt';
    }
  } catch {
    /* ignore */
  }
  return 'chatgpt';
}

function providerBlock(baseUrl, providerId, idleTimeout) {
  const namespace = providerId === 'iia_http' ? 'iia' : 'msb';
  return [
    `# BEGIN ${namespace}-ext codex-http`,
    `# HTTP-only: без Responses WebSocket (см. openai/codex#20739, #22634)`,
    `model_provider = "${providerId}"`,
    'stream_idle_timeout_ms = ' + idleTimeout,
    '',
    `[model_providers.${providerId}]`,
    `name = "${namespace.toUpperCase()} HTTP (no websocket)"`,
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'supports_websockets = false',
    `# END ${namespace}-ext codex-http`,
    '',
  ].join('\n');
}

/**
 * Пишет/обновляет HTTP-only provider в ~/.codex/config.toml.
 * Не затирает чужие секции; свой блок между маркерами заменяет целиком.
 * @returns {Promise<{ok:boolean, providerId:string, baseUrl:string, changed:boolean}>}
 */
export async function ensureCodexStableTransport(home, env = process.env) {
  home ??= env.HOME || os.homedir();
  const file = path.join(codexHome(home), 'config.toml');
  const authMode = await detectAuthMode(home);
  const baseUrl = authMode === 'api' ? API_BASE : CODEX_CHATGPT_BASE;

  return withCodexConfig(file, (text, save) => configureTransport(text, save, home, env, baseUrl));
}

async function configureTransport(text, save, home, env, baseUrl) {
  const scalars = parseCodexTomlScalars(text);
  const currentProvider = scalars.model_provider || 'openai';
  // Existing native provider identity is part of the session/config contract.
  const providerId = ['iia_http', MSB_HTTP_PROVIDER_ID].includes(currentProvider)
    ? currentProvider : profile.resolveProfile(env, home).codexHttpProviderId;
  const namespace = providerId === 'iia_http' ? 'iia' : 'msb';
  const markBegin = `# BEGIN ${namespace}-ext codex-http`;
  const markEnd = `# END ${namespace}-ext codex-http`;
  const block = providerBlock(baseUrl, providerId, scalars.stream_idle_timeout_ms || '600000');
  // Не перехватываем ollama/lmstudio/custom — только дефолтный openai и наш msb_http.
  const managed =
    !currentProvider ||
    ['openai', 'iia_http', MSB_HTTP_PROVIDER_ID, 'chatgpt', 'chatgpt-http', 'openai_http'].includes(currentProvider);

  let next = text;
  const begin = next.indexOf(markBegin);
  const end = next.indexOf(markEnd);
  if (begin >= 0 && end > begin) {
    const after = end + markEnd.length;
    next = `${next.slice(0, begin).trimEnd()}\n\n${block}${next.slice(after).replace(/^\n+/, '')}`;
  } else if (managed) {
    // Both managed settings belong at the root, before any user tables.
    const tableAt = text.search(/^[ \t]*\[/m);
    const root = tableAt < 0 ? text : text.slice(0, tableAt);
    const tables = tableAt < 0 ? '' : text.slice(tableAt);
    const rest = root.replace(/^[ \t]*(?:model_provider|stream_idle_timeout_ms)[ \t]*=.*(?:\n|$)/gm, '').trimEnd();
    next = rest + '\n\n' + block + tables;
  } else {
    // Чужой provider: только увеличим idle timeout, WS не трогаем.
    if (!/^stream_idle_timeout_ms\s*=/m.test(next)) {
      next = `${next.trimEnd()}\n\nstream_idle_timeout_ms = 600000\n`;
    }
  }

  const changed = next !== text;
  if (changed) await save(next);

  return {
    ok: true,
    providerId: managed ? providerId : currentProvider,
    baseUrl: managed ? baseUrl : null,
    changed,
    skippedProviderSwitch: !managed,
  };
}

/** CLI `-c` для хода бота: принудительно HTTP-only, если блок msb_http на месте. */
export function codexHttpProviderOverrides(force = true, providerId = profile.resolveProfile().codexHttpProviderId) {
  if (!force) return [];
  return ['-c', `model_provider=${JSON.stringify(providerId)}`];
}
