import { callbackTransportScope } from '../../shared/callback-renders.mjs';
/** Presentation requests may fail quietly; never retry an obsolete animation. */
const presentationSignals = new WeakSet();
export function presentationSignal(signal) {
  presentationSignals.add(signal);
  return signal;
}
export function presentationAwareRetry(retry) {
  return (previous, method, payload, signal) => {
    const callback = callbackTransportScope(signal);
    if (callback) {
      // Preserve the existing retry policy, but cancel obsolete retry pauses.
      // The accepted physical request is independent of navigation, just like
      // progress.stop() drains its edit before terminal delivery.
      return retry(async (method, payload) => {
        callback.signal.throwIfAborted();
        const result = await previous(method, payload, AbortSignal.timeout(15_000));
        callback.signal.throwIfAborted();
        return result;
      }, method, payload, callback.signal);
    }
    return presentationSignals.has(signal)
      ? previous(method, payload, signal)
      : retry(previous, method, payload, signal);
  };
}
