/**
 * One in-process env mutation queue, like old xK. Not a cross-process lock.
 * Core [store](../src/env/store.mjs) and provider ext/env share this exact module
 * through the existing shared alias; validation/target resolution stay in caller.
 * [Order/failure/profile tests](../tests/env-write-order.test.mjs).
 */
let tail = Promise.resolve();
export function serializeEnvMutation(mutate) {
  const operation = tail.then(mutate);
  tail = operation.catch(() => {});
  return operation;
}
