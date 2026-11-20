/**
 * Shared bounded display text for [Telegram/Pult journal](../telegram/history.mjs)
 * and [session descriptions](../sessions/ledger.mjs). No I/O or native transcripts.
 * Keep existing journal redaction unchanged; [checks](../../tests/turn-history.test.mjs).
 */
export function historyPreview(value) {
  return String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY)[^-]*-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[скрыто]')
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[скрыто]')
    .replace(/\b(?:sk-|dg_)[A-Za-z0-9_-]{16,}\b/g, '[скрыто]')
    .replace(/(\b(?:password|passwd|token|secret|api[_-]?key|authorization)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[скрыто]')
    .replace(/([?&](?:token|key|tg|code|secret)=)[^&#\s]+/gi, '$1[скрыто]')
    .slice(0, 1000);
}
