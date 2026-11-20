/**
 * Shared text-input deadline and the legacy env/Claude timeout messages; no state/I/O.
 * Used by [core forms](../src/telegram/pending-input.mjs) and
 * [provider/IP input](../../../overlay/bot/ext/integration/text-input.mjs).
 * Their stores keep ownership independently; late input is consumed before the model.
 * Checks: [core](../tests/menu-handlers.test.mjs),
 * [overlay](../../../overlay/bot/ext/tests/input-scope.test.mjs).
 */
export const INPUT_TTL_MS = 10 * 60 * 1000;
export const AUTH_INPUT_EXPIRED = '⏳ Время на ввод токена истекло (10 мин) — режим ввода сброшен. Начни заново: /settings → 🔌 Подключение.';
export const ENV_INPUT_EXPIRED = '⏳ Время на ввод переменной истекло (10 мин) — режим ввода сброшен. Начни заново: /settings → 🔑 Переменные.';
