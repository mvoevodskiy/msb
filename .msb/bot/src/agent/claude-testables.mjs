/** Вынесено для unit-тестов без spawn. */

export function parseStreamLineForTest(line) {
  const A = line.trim();
  if (!A) return null;
  try {
    const Q = JSON.parse(A);
    if (Q && typeof Q.type === 'string') return Q;
    return null;
  } catch {
    return null;
  }
}

export function buildArgsForTest({
  model,
  sessionId,
  permissionMode = 'bypassPermissions',
  effort,
  systemPrompt,
  maxTurns = 200,
  allowedTools = 'Bash,Read,Edit,Write',
} = {}) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(maxTurns),
    '--permission-mode',
    permissionMode,
    '--allowedTools',
    allowedTools,
  ];
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (sessionId) args.push('--resume', sessionId);
  return args;
}
