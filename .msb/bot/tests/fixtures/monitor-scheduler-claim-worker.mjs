/** Separate synthetic scheduler process for the monitor claim regression. */
import { startMonitorScheduler } from '../../src/monitor/scheduler.mjs';

const OriginalDate = globalThis.Date;
const fixtureNow = OriginalDate.parse('2026-11-16T09:15:00.000Z');
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [fixtureNow])); }
  static now() { return fixtureNow; }
};

let release;
const held = new Promise(resolve => { release = resolve; });
globalThis.fetch = async url => {
  if (String(url) !== 'https://fixture.invalid/feed') throw Error('unexpected synthetic URL');
  process.send?.({ event: 'fetch' });
  if (process.env.FIXTURE_ROLE === 'slow') await held;
  const body = process.env.FIXTURE_ROLE === 'slow' ?
    '<rss><item><guid>new-fixture</guid><title>new fixture</title><link>https://fixture.invalid/new</link><pubDate>2026-11-16T09:10:00Z</pubDate></item></rss>' :
    '<rss><channel></channel></rss>';
  return { ok: true, text: async () => body };
};

const scheduler = startMonitorScheduler({ adminId: 42,
  api: { sendMessage: async (_chat, text) => { process.send?.({ event: 'delivery', includesNew: text.includes('new fixture') }); } },
  log: message => { if (message.includes('tick error')) process.send?.({ event: 'error', message }); } });
let started = false;
process.on('message', async message => {
  if (message === 'release') release();
  if (message === 'start' && !started) {
    started = true;
    try { await scheduler.tickNow(); process.send?.({ event: 'done' }); }
    catch (error) { process.send?.({ event: 'error', message: error.message }); }
    finally { scheduler.stop(); }
  }
});
process.send?.({ event: 'ready' });
