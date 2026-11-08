/**
 * Service/custom metadata → common system prompt; no values or previews.
 * [Services](./services.mjs) owns old catalog/status and delegates Deepgram to STT;
 * [store](./store.mjs) owns registered custom names/descriptions, not activation.
 * Caller: [system prompt](../agent/system-prompt.mjs) → existing Claude/Codex routes.
 * [Contract](../../tests/reference/parity-env-services-contract.txt),
 * [service tests](../../tests/env-services.test.mjs), [custom tests](../../tests/env-description.test.mjs).
 */
import profile from '../../shared/profile.cjs';
import {listEnvEntries,PROTECTED_KEYS,QUICK_KEYS} from './store.mjs';
import {envServiceMetadata,ENV_SERVICE_KEYS} from './services.mjs';
const INTERNAL=new Set(QUICK_KEYS.filter(row=>row.key.startsWith('PULT_')).map(row=>row.key));

export async function envCapabilityPrompt(env = process.env) {
  const services = (await envServiceMetadata(env)).flatMap(row => {
    let note;
    if (row.status === 'configured') note = `ключ задан в ${row.source}.`;
    else if (row.status === 'unknown') note = `состояние ключа в ${row.source} неизвестно.`;
    else if (row.hint) note = `в ${row.source} ключ не задан (добавь через /settings → 🔑).`;
    return note ? [`- ${row.key}: ${row.label} — ${note}`] : [];
  });
  // Descriptions are optional context. A read failure must not hide known
  // process/STT rows or abort a text turn; UI/writer errors remain unchanged.
  let entries, customUnavailable = false;
  try { entries = await listEnvEntries(env); }
  catch { entries = []; customUnavailable = true; }
  const custom = entries.filter(row => !PROTECTED_KEYS.has(row.key)
    && !ENV_SERVICE_KEYS.has(row.key) && !INTERNAL.has(row.key) && profile.envValue(env, row.key));
  const lines = [...services, ...custom.map(row => `- ${row.key}: ${row.comment || 'добавлен через /settings'}`)];
  if (customUnavailable) lines.push('Дополнительные имена и описания ключей сейчас недоступны.');
  if (!lines.length) return '';
  return ['## Сервисы и ключи',
    'Это сведения о настройках. Наличие ключа не подтверждает авторизацию, доступность API или встроенного инструмента.',
    ...lines].join('\n');
}
