/** Run selected generic/Codex timer tests with the unrelated dispatcher mocked. */
import { mock } from 'node:test';
mock.module(new URL('../../src/autonomy/openclaw-reminder-dispatch.mjs',import.meta.url),{
  namedExports:{createOpenClawReminderDispatcher:()=>async()=>{}},
});
await import('../legacy-timer-dispatch.test.mjs');
