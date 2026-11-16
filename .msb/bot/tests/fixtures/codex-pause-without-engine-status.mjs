/** Run selected Codex/Claude switch tests without an engine status read. */
import {mock} from 'node:test';
const url=new URL('../../src/engines/client.mjs',import.meta.url).href;
const engine=await import(url);
mock.module(url,{namedExports:{...engine,engineStatusSnapshot:async()=>null}});
await import('../codex-pause-switch.test.mjs');
