/**
 * Replayed, partial and isolated receipts for [scheduled Codex](../adapters/saved-codex.mjs).
 * The native probe additionally checks the same path against the pinned CLI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createSavedCodexUsage } from '../adapters/saved-codex-usage.mjs';
import { openSavedCodexOtlp } from '../adapters/saved-codex-otlp.mjs';

const id = suffix => '0199a213-81c0-7800-8aa1-bbab2a035a' + suffix;
const root = id('53'), child = id('54'), grandchild = id('55'), foreign = id('56');
const parent = { input: 7, output: 2, cached: 3 };
const batch = logRecords => ({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] });

function events() {
  let stamp = 1_000n;
  function record(name, attributes) {
    return { observedTimeUnixNano: String(stamp++),
      attributes: Object.entries({ 'event.name': name, ...attributes }).map(([key, value]) => ({
        key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
      })) };
  }
  return {
    link(kind, sender, receiver) {
      return record('codex.agent_communication', { kind, state: 'send', sender_thread_id: sender, receiver_thread_id: receiver });
    },
    response(thread, input, output, cached = 0) {
      const common = { 'event.kind': 'response.completed', 'conversation.id': thread };
      return [
        record('codex.api_request', { 'conversation.id': thread, endpoint: '/responses', 'http.response.status_code': 200 }),
        record('codex.sse_event', common),
        record('codex.sse_event', { ...common, input_token_count: input, output_token_count: output, cached_token_count: cached }),
      ];
    },
  };
}

test('repeated receipts do not multiply equal-sized responses or charge the parent twice', () => {
  const e = events(), usage = createSavedCodexUsage();
  const first = e.response(child, 29, 2), second = e.response(child, 29, 2);
  const receipt = batch([
    e.link('spawn', root, child), e.link('spawn', child, grandchild),
    ...e.response(root, 7, 2, 3), ...first, ...second, ...e.response(grandchild, 4, 3),
    e.link('result', grandchild, child), e.link('result', child, root),
  ]);
  usage.ingest(receipt);
  usage.ingest(batch([first[1], second[2]]));
  usage.ingest(JSON.parse(JSON.stringify(receipt)));
  assert.deepEqual(usage.summarize(root, parent, true), { parent, helperTokens: 69, incomplete: false });
});

test('incomplete and foreign events preserve the known scoped lower bound', () => {
  const e = events(), usage = createSavedCodexUsage();
  const incomplete = e.response(child, 13, 8);
  usage.ingest(batch([
    e.link('spawn', root, child), ...e.response(root, 7, 2, 3),
    ...e.response(child, 29, 2), ...incomplete.slice(0, 2),
    e.link('result', child, root), ...e.response(foreign, 100, 30),
  ]));
  assert.deepEqual(usage.summarize(root, parent, true), { parent, helperTokens: 31, incomplete: true });
  const fallback = usage.summarize(root, undefined, false);
  assert.deepEqual([fallback.parent.input, fallback.parent.output, fallback.helperTokens, fallback.incomplete], [7, 2, 31, true]);
});

test('conflicting replay identities do not create a billable response', () => {
  const e = events(), usage = createSavedCodexUsage();
  const childEvents = e.response(child, 29, 2);
  const conflicting = structuredClone(childEvents[2]);
  conflicting.attributes.find(attr => attr.key === 'input_token_count').value.intValue = '200';
  usage.ingest(batch([
    e.link('spawn', root, child), ...e.response(root, 7, 2, 3),
    ...childEvents, conflicting, childEvents[2], e.link('result', child, root),
  ]));
  assert.deepEqual(usage.summarize(root, parent, true), { parent, helperTokens: undefined, incomplete: true });
});

test('the receiver isolates one invocation and accepts only bounded authorized receipts', async t => {
  const receiver = await openSavedCodexOtlp();
  t.after(receiver.close);
  const option = receiver.args[1];
  const url = option.match(/endpoint="([^"]+)"/)[1];
  const token = option.match(/x-msb-usage-token="([^"]+)"/)[1];
  const e = events();
  const body = gzipSync(JSON.stringify(batch(e.response(root, 7, 2, 3))));
  const send = (secret, data = body, encoding = 'gzip') => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': encoding, 'x-msb-usage-token': secret },
    body: data,
  });
  const rejected = await send('unrelated');
  assert.equal(rejected.status, 404);
  await rejected.text();
  assert.equal(receiver.summarize(root, parent, true).incomplete, true);
  const accepted = await send(token);
  assert.equal(accepted.status, 200);
  await accepted.text();
  assert.deepEqual(receiver.summarize(root, parent, true), { parent, helperTokens: undefined, incomplete: false });
  const oversized = await send(token, gzipSync(Buffer.alloc(4 * 1024 * 1024 + 1)));
  assert.equal(oversized.status, 400);
  await oversized.text();
  const damaged = await send(token, Buffer.from('uncompressed input'), 'gzip');
  assert.equal(damaged.status, 400);
  await damaged.text();
  await receiver.close();
  assert.deepEqual(receiver.summarize(root, parent, true), { parent, helperTokens: undefined, incomplete: true });
});
