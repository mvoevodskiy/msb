/**
 * Small Anthropic messages response for closed native [parent](./claude-saved-prompt-loopback.mjs)
 * and [helper](./claude-saved-helper-loopback.mjs) probes. Uses synthetic token counts.
 */
export function sendClaudeFixtureReply(res, { model, stream }, id, block, stopReason) {
  const message = { id, type: 'message', role: 'assistant', model, content: [block],
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  if (!stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (type, fields) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
  emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } });
  emit('content_block_delta', { index: 0, delta: block.type === 'tool_use'
    ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
  emit('message_stop', {});
  res.end();
}
