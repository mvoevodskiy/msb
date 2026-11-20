/**
 * Small Anthropic messages response for closed native [parent](./claude-saved-prompt-loopback.mjs)
 * and [helper](./claude-saved-helper-loopback.mjs) probes. Uses synthetic token counts.
 */
const fixtureUsage = { input_tokens: 11, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

export function sendClaudeFixtureReply(res, { model, stream }, id, block, stopReason, usage = fixtureUsage) {
  const content = Array.isArray(block) ? block : [block];
  const message = { id, type: 'message', role: 'assistant', model, content,
    stop_reason: stopReason, stop_sequence: null, usage };
  if (!stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (type, fields) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
  emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  for (const [index, item] of content.entries()) {
    emit('content_block_start', { index, content_block: item.type === 'tool_use' ? { ...item, input: {} } : { ...item, text: '' } });
    emit('content_block_delta', { index, delta: item.type === 'tool_use'
      ? { type: 'input_json_delta', partial_json: JSON.stringify(item.input) } : { type: 'text_delta', text: item.text } });
    emit('content_block_stop', { index });
  }
  emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  emit('message_stop', {});
  res.end();
}
