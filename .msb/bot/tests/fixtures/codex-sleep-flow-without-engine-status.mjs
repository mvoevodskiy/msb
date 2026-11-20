/** Selected Codex sleep/stop cases without unrelated engine status reads. */
import { mock } from 'node:test';
const url = new URL('../../src/engines/client.mjs', import.meta.url).href;
const engine = await import(url);
mock.module(url, { namedExports: { ...engine, engineStatusSnapshot: async () => null } });
await import('../codex-sleep-flow.test.mjs');
