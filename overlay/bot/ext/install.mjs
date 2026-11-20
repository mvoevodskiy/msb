/**
 * Совместимый вход интеграции overlay с grammy; prepare() вызывается до импорта ядра.
 * Навигация: [Обвязка](./README.md).
 *
 * installUpdateHook экспортируется статически и не тянет grammy — это нужно тестам ядра,
 * которые патчат harness без установленного overlay/node_modules.
 * prepare подгружает startup (и grammy) только при вызове.
 */
export { installUpdateHook } from './integration/update-hook.mjs';

export async function prepare() {
  const { prepare: boot } = await import('./integration/startup.mjs');
  return boot();
}
