/**
 * Old lK value contract: raw value + key → trimmed string or safe reason.
 * No file/profile/network access, no successful-auth claim.
 * Callers: [store](./store.mjs), [form](../telegram/forms/env.mjs).
 * [Contract](../../tests/reference/parity-env-value-contract.txt),
 * [production checks](../../tests/env-value.test.mjs).
 */
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const TELEGRAM_NAME = /TELEGRAM|^BOT_TOKEN$/i;
const TELEGRAM_VALUE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const TARGETS = [[/ANTHROPIC/i,'Anthropic'],[/OPENROUTER/i,'OpenRouter'],[/OPENAI/i,'OpenAI']];
const PREFIXES = [[/^sk-ant-/i,'Anthropic'],[/^sk-or-/i,'OpenRouter'],[/^AIza/,'Google'],[/^xai-/i,'xAI']];
const LINE = 'Значение должно быть одной строкой, без переносов и служебных символов. Пришли только сам ключ/токен.';
const JSON_NOTE = 'Похоже, это целый JSON (например ключ сервисного аккаунта), а не одно значение. Переменная окружения должна быть ОДНОЙ строкой — так вставлять нельзя. Напиши в поддержку, если нужно подключить именно такой ключ.';

export function validateEnvValue(value, key = '') {
  if (typeof value !== 'string') throw new Error('Значение должно быть одной строкой, без переводов строки и NUL.');
  const normalized = value.trim();
  if (!normalized) throw new Error('Значение пустое.');
  if (/[\r\n]/.test(value) || CONTROL.test(normalized)) {
    const json = normalized.startsWith('{') && normalized.endsWith('}')
      && (normalized.match(/"[A-Za-z0-9_]+"\s*:/g)?.length || 0) >= 2;
    throw new Error(json ? JSON_NOTE : LINE);
  }
  if (normalized.length > 4000) throw new Error(`Значение слишком длинное (${normalized.length} символов, максимум 4000). Похоже на вставку целого файла — пришли только сам ключ.`);
  if (TELEGRAM_NAME.test(key) && !TELEGRAM_VALUE.test(normalized)) {
    throw new Error('Не похоже на токен Telegram-бота. Формат: <цифры>:<буквы/цифры> (как выдаёт @BotFather).');
  }
  const target = TARGETS.find(([pattern]) => pattern.test(key))?.[1];
  const other = target && PREFIXES.find(([pattern,name]) => name !== target && pattern.test(normalized))?.[1];
  if (other) throw new Error(`Это похоже на ключ ${other}, а не ${target}. Проверь, тот ли ключ вставляешь.`);
  return normalized;
}
