/** Related saved-action regression suites, unrelated dispatcher replaced before import. */
import { mock } from 'node:test';
mock.module(new URL('../../src/autonomy/openclaw-reminder-dispatch.mjs', import.meta.url), {
  namedExports: { createOpenClawReminderDispatcher: () => async () => {} },
});
await import('../reminder-limits.test.mjs');
await import('../task-reschedule.test.mjs');
