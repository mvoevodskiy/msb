/** Минимальный Claude Code stream-json, достаточный для парсера бандла. */

export function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export function emitInit({ sessionId, model, providerId }) {
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: model || `ext/${providerId}`,
    tools: [],
    apiKeySource: 'ext',
    provider_id: providerId,
  });
}

function normalizeUsage(usage, text, providerId) {
  if (usage && typeof usage === 'object') {
    return {
      input_tokens: Math.max(0, (Number(usage.input_tokens) || 0) - (providerId === 'codex' ? Number(usage.cached_input_tokens) || 0 : 0)),
      output_tokens: Number(usage.output_tokens) || Math.max(1, Math.ceil(String(text || '').length / 4)),
      cache_read_input_tokens: Number(usage.cached_input_tokens) || 0,
    };
  }
  return {
    input_tokens: 0,
    output_tokens: Math.max(1, Math.ceil(String(text || '').length / 4)),
  };
}

export function emitAssistantText(text, sessionId, { model, usage, providerId } = {}) {
  emit({
    type: 'assistant',
    message: {
      id: `ext_msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: model || 'ext',
      content: [{ type: 'text', text: text || '(пустой ответ)' }],
      stop_reason: 'end_turn',
      usage: normalizeUsage(usage, text, providerId),
    },
    session_id: sessionId,
  });
}

export function emitResult({ sessionId, text, isError = false, subtype, errorStatus, usage, model, providerId, errorDisplay }) {
  const payload = {
    type: 'result',
    subtype: subtype ?? (isError ? 'error' : 'success'),
    session_id: sessionId,
    is_error: !!isError,
    result: text || '',
    total_cost_usd: 0,
  };
  if (model) payload.model = model;
  if (errorDisplay) payload.error_display = errorDisplay;
  if (usage && typeof usage === 'object') {
    payload.usage = normalizeUsage(usage, text, providerId);
  }
  if (typeof errorStatus === 'number') payload.api_error_status = errorStatus;
  emit(payload);
}

export function emitError(message, sessionId, { model } = {}) {
  emitAssistantText(`⚠️ ${message}`, sessionId, { model });
  emitResult({ sessionId, text: message, isError: true, model });
}
