/**
 * Reconciles one saved CLI's token events with its parent exec summary.
 * Input is the pinned CLI's [local OTLP receiver](./saved-codex-otlp.mjs).
 * [Native regression](../../../../.msb/bot/tests/fixtures/codex-saved-helper-loopback.mjs).
 */
const maxEvents = 16_384;
const fields = new Set(['event.name', 'event.kind', 'conversation.id', 'endpoint', 'http.response.status_code',
  'input_token_count', 'output_token_count', 'cached_token_count', 'kind', 'state', 'sender_thread_id', 'receiver_thread_id']);
const isThread = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

function count(value) {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readEvent(record) {
  const attrs = {};
  for (const entry of record?.attributes ?? []) {
    if (fields.has(entry?.key)) attrs[entry.key] = entry.value?.stringValue ?? entry.value?.intValue;
  }
  const name = attrs['event.name'];
  if (name === 'codex.agent_communication' && attrs.state === 'send' && ['spawn', 'result'].includes(attrs.kind)) {
    const thread = attrs.sender_thread_id, peer = attrs.receiver_thread_id;
    return isThread(thread) && isThread(peer) ? { kind: attrs.kind, thread, peer } : null;
  }
  const thread = attrs['conversation.id'];
  if (name === 'codex.api_request' && attrs.endpoint === '/responses' && count(attrs['http.response.status_code']) === 200) {
    return isThread(thread) ? { kind: 'request', thread } : null;
  }
  if (name !== 'codex.sse_event' || attrs['event.kind'] !== 'response.completed') return;
  if (!isThread(thread)) return null;
  if (!Object.hasOwn(attrs, 'input_token_count') && !Object.hasOwn(attrs, 'output_token_count')) {
    return { kind: 'completion', thread };
  }
  const input = count(attrs.input_token_count), output = count(attrs.output_token_count);
  const cached = count(attrs.cached_token_count) ?? 0;
  return input === undefined || output === undefined || cached > input ? null
    : { kind: 'tokens', thread, input, output, cached };
}

export function parseSavedCodexUsage(usage) {
  const input = count(usage?.input_tokens), output = count(usage?.output_tokens);
  if (input === undefined || output === undefined) return;
  return { input, output, cached: Math.min(input, count(usage.cached_input_tokens) ?? 0) };
}

export function createSavedCodexUsage() {
  const events = new Map();
  let incomplete = false;

  function ingest(batch) {
    if (!Array.isArray(batch?.resourceLogs)) throw new Error('Invalid OTLP batch');
    for (const resource of batch.resourceLogs) {
      for (const scope of resource.scopeLogs) {
        for (const record of scope.logRecords) {
          const event = readEvent(record);
          if (event === undefined) continue;
          const stamp = record.observedTimeUnixNano;
          if (!event || typeof stamp !== 'string' || !/^[1-9]\d{0,19}$/.test(stamp)) {
            incomplete = true;
            continue;
          }
          // The pinned exporter preserves this observed time on an exact replay.
          // Equal token counts in distinct completed responses must both count.
          const key = [stamp, event.kind, event.thread, event.peer].join('/');
          if (events.has(key)) {
            if (JSON.stringify(events.get(key)) !== JSON.stringify(event)) {
              events.set(key, null);
              incomplete = true;
            }
          } else if (events.size < maxEvents) events.set(key, event);
          else incomplete = true;
        }
      }
    }
  }

  function summarize(thread, native, clean) {
    let partial = incomplete || !clean;
    const rows = new Map(), children = new Map(), finished = new Map();
    for (const event of events.values()) {
      if (!event) continue;
      if (event.kind === 'spawn' || event.kind === 'result') {
        const table = event.kind === 'spawn' ? children : finished;
        if (!table.has(event.thread)) table.set(event.thread, new Set());
        table.get(event.thread).add(event.peer);
        continue;
      }
      const row = rows.get(event.thread) ?? { request: 0, completion: 0, tokens: 0, input: 0, output: 0, cached: 0 };
      if (event.kind === 'tokens') {
        if (['input', 'output', 'cached'].some(key => !Number.isSafeInteger(row[key] + event[key]))) {
          partial = true;
          continue;
        }
        for (const key of ['input', 'output', 'cached']) row[key] += event[key];
      }
      row[event.kind]++;
      rows.set(event.thread, row);
    }

    const family = new Set([thread]);
    for (const parent of family) {
      for (const child of children.get(parent) ?? []) {
        family.add(child);
        if (!finished.get(child)?.has(parent)) partial = true;
      }
    }

    let helperTokens;
    for (const child of family) {
      const row = rows.get(child);
      if (!row?.tokens || row.tokens !== row.completion || row.tokens !== row.request) partial = true;
      if (child === thread || !row?.tokens) continue;
      const total = (helperTokens ?? 0) + row.input + row.output;
      if (Number.isSafeInteger(total)) helperTokens = total;
      else partial = true;
    }
    if ([...rows.keys(), ...children.keys(), ...finished.keys()].some(id => !family.has(id))) partial = true;

    const parent = rows.get(thread);
    if (!native || !parent || ['input', 'output', 'cached'].some(key => native[key] !== parent[key])) partial = true;
    return { parent: native ?? (parent?.tokens ? parent : undefined), helperTokens, incomplete: partial };
  }

  return { ingest, summarize, markIncomplete() { incomplete = true; } };
}
