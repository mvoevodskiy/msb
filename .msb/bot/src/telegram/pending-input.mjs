/**
 * Core text-form ownership and the old env/Claude deadline; no timers or I/O.
 * [createBot](./bot.mjs) consumes notices before form writes and model admission.
 * Callback starts use set(); env step transitions use advance() to keep the clock.
 * Private payload owns transient env drafts and project prompt delivery/ID, cleared by set/delete/clear;
 * read() never exposes their value. Voice never reads/consumes this state. Other form kinds have no implied TTL.
 * [Old contract](../../tests/reference/parity-forms-contract.txt),
 * [handler checks](../../tests/menu-handlers.test.mjs).
 */
import { INPUT_TTL_MS, AUTH_INPUT_EXPIRED, ENV_INPUT_EXPIRED } from '../../shared/input-notices.mjs';
export { INPUT_TTL_MS };
const timed = kind => kind === 'auth-token' || kind === 'env-key-name' || kind?.startsWith('env:') || kind?.startsWith('env-comment:');

export class PendingInputs extends Map {
  #startedAt = new Map();
  #payload = new Map();
  constructor({ now = Date.now } = {}) { super(); this.now = now; }
  set(chatId, kind) {
    this.#startedAt.set(chatId, this.now());
    this.#payload.delete(chatId);
    return super.set(chatId, kind);
  }
  advance(chatId, kind, payload) {
    if (!this.has(chatId)) this.set(chatId, kind);
    if (payload === undefined) this.#payload.delete(chatId); else this.#payload.set(chatId, payload);
    return super.set(chatId, kind);
  }
  payload(chatId) { return this.#payload.get(chatId); }
  delete(chatId) { this.#startedAt.delete(chatId); this.#payload.delete(chatId); return super.delete(chatId); }
  clear() { this.#startedAt.clear(); this.#payload.clear(); super.clear(); }
  read(chatId) {
    const kind = this.get(chatId);
    return { kind, expired: Boolean(timed(kind) && this.now() - this.#startedAt.get(chatId) > INPUT_TTL_MS) };
  }
}

/** Registered commands were already handled; only reached text is checked here. */
export function pendingInputNotice({ kind, expired }, text) {
  if (!timed(kind)) return null;
  const auth = kind === 'auth-token';
  if (expired) return auth ? AUTH_INPUT_EXPIRED : ENV_INPUT_EXPIRED;
  if (text.trimStart().startsWith('/')) return auth
    ? 'Вышел из режима ввода токена — команда не была сохранена. Отправь её ещё раз.'
    : 'Вышел из режима ввода переменной — команда не была сохранена как значение. Отправь её ещё раз.';
  return null;
}
