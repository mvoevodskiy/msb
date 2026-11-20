/**
 * Native Claude compact settings and context occupied by its latest input.
 * [CLI runner](./claude.mjs) captures the launch values and usage samples.
 * [Ordinary turn](./turn.mjs) passes the measurement to the existing footer.
 * Old Nu/IJ: blob 73aa9e7e at 3353–3371, 19524–19525 and 19772–19789.
 * [Telegram and CLI checks](../../tests/claude-context-footer.test.mjs).
 */
import { cleanClaudeModelId } from './models.mjs';

const inputFields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

export function claudeCompactSettings(model, env) {
  // In old V1 only the Haiku alias has the small window. Haiku 5.5 pinned has 1M.
  const defaultWindow = cleanClaudeModelId(model).toLowerCase() === 'haiku' ? '200000' : '1000000';
  const window = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || defaultWindow;
  const percent = env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE || '90';
  const capacity = Number(window);
  const rate = Number(percent);
  const threshold = Number.isSafeInteger(capacity) && capacity > 0 && rate > 0 && rate <= 100
    ? Math.floor(capacity * (rate / 100))
    : 0;
  return { window, percent, threshold };
}

export function updateClaudeInputSample(sample, usage) {
  for (const field of inputFields) {
    const count = usage?.[field];
    if (Number.isSafeInteger(count) && count >= 0) sample[field] = count;
  }
}

function inputTokens(usage) {
  let total = 0;
  for (const field of inputFields) {
    const count = usage?.[field];
    if (Number.isSafeInteger(count) && count >= 0) total += count;
  }
  return Number.isSafeInteger(total) ? total : 0;
}

export function claudeTurnContext(threshold, latestInput, terminalUsage) {
  const tokens = inputTokens(latestInput) || inputTokens(terminalUsage);
  return threshold > 0 && tokens > 0 ? { contextTokens: tokens, contextWindow: threshold } : null;
}
