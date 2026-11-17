/** Shared Codex transport-error classification for exec and app-server.
 * [Adapter](./codex.mjs) formats the existing interruption notice; the
 * [app-server](./codex-app-server.mjs) also detects it in a bounded stderr tail.
 */
export function isCodexStreamCutMessage(text) {
  return /stream disconnected|websocket closed|Reconnecting\.\.\.\s*\d+\/\d+|Falling back from WebSockets/i.test(String(text || ''));
}
