/** Selective release keeps the shared [Codex pause policy](./codex-sleep.mjs).
 * [Ingress/queue](../telegram/bot.mjs); [checks](../../tests/codex-sleep-flow.test.mjs). */
export { createCodexSleep as createEngineSleep } from './codex-sleep.mjs';
