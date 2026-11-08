/**
 * Core text-form ownership and the old env/Claude deadline; no timers or I/O.
 * [createBot](./bot.mjs) consumes notices before form writes and model admission.
 * Callback starts use set(); env step transitions use advance() to keep the clock.
 * Voice never reads/consumes this state. Other form kinds have no implied TTL.
 * [Old contract](../../tests/reference/parity-forms-contract.txt),
 * [handler checks](../../tests/menu-handlers.test.mjs).
 */
export const INPUT_TTL_MS = 10 * 60 * 1000;
const timed = kind => kind === 'auth-token' || kind === 'env-key-name' || kind?.startsWith('env:');

export class PendingInputs extends Map {
  #startedAt = new Map();
  constructor({ now = Date.now } = {}) { super(); this.now = now; }
  set(chatId, kind) {
    this.#startedAt.set(chatId, this.now());
    return super.set(chatId, kind);
  }
  advance(chatId, kind) {
    if (!this.has(chatId)) return this.set(chatId, kind);
    return super.set(chatId, kind);
  }
  delete(chatId) { this.#startedAt.delete(chatId); return super.delete(chatId); }
  clear() { this.#startedAt.clear(); super.clear(); }
  read(chatId) {
    const kind = this.get(chatId);
    return { kind, expired: Boolean(timed(kind) && this.now() - this.#startedAt.get(chatId) > INPUT_TTL_MS) };
  }
}

/** Registered commands were already handled; only reached text is checked here. */
export function pendingInputNotice({ kind, expired }, text) {
  if (!timed(kind)) return null;
  const auth = kind === 'auth-token';
  if (expired) return auth
    ? '⏳ Время на ввод токена истекло (10 мин) — режим ввода сброшен. Начни заново: /settings → 🔌 Подключение.'
    : '⏳ Время на ввод переменной истекло (10 мин) — режим ввода сброшен. Начни заново: /settings → 🔑 Переменные.';
  if (text.trimStart().startsWith('/')) return auth
    ? 'Вышел из режима ввода токена — команда не была сохранена. Отправь её ещё раз.'
    : 'Вышел из режима ввода переменной — команда не была сохранена как значение. Отправь её ещё раз.';
  return null;
}
