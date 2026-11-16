/** Existing Telegram stop shapes, shared by sleep admission and overlay ingress. */
export function isStopInput(message) {
  const text = message?.text || '';
  return /^\/stop(?:@\w+)?(?:\s|$)/.test(text) ||
    (text.toLowerCase() === 'стоп' && Boolean(message?.reply_to_message));
}
