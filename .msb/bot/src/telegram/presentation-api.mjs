import { callbackTransportScope } from '../../shared/callback-renders.mjs';
/** A request with stale UI or a non-repeatable send must bypass transport retries. */
const singleRequests = new WeakSet();
export function singleRequestSignal(signal) {
  singleRequests.add(signal);
  return signal;
}
export const presentationSignal = singleRequestSignal;

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
    return singleRequests.has(signal)
      ? previous(method, payload, signal)
      : retry(previous, method, payload, signal);
  };
}
