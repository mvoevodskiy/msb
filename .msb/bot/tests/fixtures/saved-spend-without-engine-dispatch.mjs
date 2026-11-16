/** Run saved spend-pause checks with the unrelated dispatcher replaced before import. */
import { mock } from 'node:test';
mock.module(new URL('../../src/autonomy/openclaw-reminder-dispatch.mjs', import.meta.url), {
  namedExports: { createOpenClawReminderDispatcher: () => async () => {} },
});
await import('../saved-spend-pause.test.mjs');
