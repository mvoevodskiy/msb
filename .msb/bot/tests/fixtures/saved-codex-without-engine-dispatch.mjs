/** Selected saved Codex action tests with the unrelated dispatcher replaced. */
import { mock } from 'node:test';
mock.module(new URL('../../src/autonomy/openclaw-reminder-dispatch.mjs', import.meta.url), {
  namedExports: { createOpenClawReminderDispatcher: () => async () => {} },
});
await import('../saved-codex-prompt-action.test.mjs');
