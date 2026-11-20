/** Shared task persistence and compact checks with unrelated dispatcher mocked. */
import { mock } from 'node:test';
mock.module(new URL('../../src/autonomy/openclaw-reminder-dispatch.mjs', import.meta.url), {
  namedExports: { createOpenClawReminderDispatcher: () => async () => {} },
});
await import('../autonomy-store-concurrency.test.mjs');
await import('../autonomy-compact-guard.test.mjs');
