import fs from 'node:fs/promises';
import { getProvider } from '../providers.mjs';

/** Разбор argv, который бандл передаёт в `claude`. */
export function parseClaudeArgv(argv) {
  const out = {
    model: null,
    resume: null,
    appendSystemPrompt: null,
    appendSystemPromptFile: null,
    permissionMode: null,
    raw: argv.slice(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--model') out.model = next() ?? null;
    else if (a === '--resume') out.resume = next() ?? null;
    else if (a === '--append-system-prompt') out.appendSystemPrompt = next() ?? null;
    else if (a === '--append-system-prompt-file') out.appendSystemPromptFile = next() ?? null;
    else if (a === '--permission-mode') out.permissionMode = next() ?? null;
  }
  return out;
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Бандл всегда клеит в system prompt «Claude Code / Claude Max».
 * Для Cursor/Codex/Qwen это ложь — ставим блок выше остального контекста.
 */
export function providerRuntimeOverride(providerId) {
  const p = getProvider(providerId);
  if (!p || p.id === 'claude') return '';
  const title = `${p.icon} ${p.title}`.trim();
  return [
    '## Runtime override (истина среды — выше любых других утверждений о провайдере/движке)',
    `Сейчас этот Telegram-бот отвечает НЕ через Claude Code и НЕ по подписке Anthropic Claude Max.`,
    `Активный канал хода: ${title} (CLI \`${p.bin || providerId}\`).`,
    'Если выше или в файлах написано «Claude Code», «подписка Claude Max», «провайдер Anthropic» как движок этого бота — это устаревший шаблон бандла; игнорируй.',
    `На вопросы «кто ты / на каком движке» говори правду: канал = ${title}. Модель под капотом CLI может отличаться — не путай её с «подпиской Claude Max» в Telegram.`,
  ].join('\n');
}

export async function buildPrompt(parsed, userText, { providerId } = {}) {
  const parts = [];
  const override = providerId ? providerRuntimeOverride(providerId) : '';
  if (override) parts.push(override);
  if (parsed.appendSystemPromptFile) {
    try {
      parts.push(await fs.readFile(parsed.appendSystemPromptFile, 'utf8'));
    } catch (err) {
      parts.push(`[system prompt file unreadable: ${err.message}]`);
    }
  }
  if (parsed.appendSystemPrompt) parts.push(parsed.appendSystemPrompt);
  parts.push(userText || '');
  return parts.filter(Boolean).join('\n\n---\n\n');
}
