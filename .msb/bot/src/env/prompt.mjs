/**
 * Old user-added env capabilities: names/descriptions only, never stored values.
 * [System prompt](../agent/system-prompt.mjs) → existing CLI/shim prompt routes.
 * Known service/backend capability claims are separate; only active custom keys.
 * [Contract](../../tests/reference/parity-env-description-contract.txt),
 * [Tests](../../tests/env-description.test.mjs).
 */
import profile from '../../shared/profile.cjs';
import { listEnvEntries, PROTECTED_KEYS, QUICK_KEYS } from './store.mjs';
const KNOWN = new Set([
  ...QUICK_KEYS.map(row => row.key),
  'VOYAGE_API_KEY','SERPER_API_KEY','BRAVE_API_KEY','SUPABASE_URL','SUPABASE_ACCESS_TOKEN',
  'VERCEL_TOKEN','RAILWAY_TOKEN','GOOGLE_API_KEY','GEMINI_API_KEY','OPENAI_API_KEY',
  'REPLICATE_API_TOKEN','CLOUDFLARE_API_TOKEN','NANOBANANA_API_KEY','FAL_KEY','SUPADATA_API_KEY','APIFY_API_KEY',
]);
export async function envCapabilityPrompt(env = process.env) {
  const rows = (await listEnvEntries(env)).filter(row => !PROTECTED_KEYS.has(row.key)
    && !KNOWN.has(row.key) && profile.envValue(env,row.key));
  if (!rows.length) return '';
  return ['## Настроенные сервисы','Все ключи доступны в Bash через $ИМЯ.',
    ...rows.map(row => `- ${row.key}: ${row.comment || 'добавлен через /settings'}`)].join('\n');
}
