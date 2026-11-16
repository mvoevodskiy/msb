/** Saved Claude fixture with the unrelated dispatcher replaced before import. */
import { mock } from 'node:test';
mock.module(new URL('../../src/autonomy/openclaw-reminder-dispatch.mjs', import.meta.url), {
  namedExports: { createOpenClawReminderDispatcher: () => async () => {} },
});
await import('../saved-prompt-action.test.mjs');
