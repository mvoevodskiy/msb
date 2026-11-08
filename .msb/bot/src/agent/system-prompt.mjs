import profile from '../../shared/profile.cjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { envCapabilityPrompt } from '../env/prompt.mjs';
import { workspaceDir } from '../paths.mjs';

const FILES = ['SOUL.md', 'CLAUDE.md', 'USER.md', 'MEMORY.md', 'TELEGRAM-TOOLS.md'];

/**
 * Собирает append-system-prompt из workspace (как context-loader закрытого ядра, упрощённо).
 * Навигация: [Исполнение](./README.md) → [profile label](../../shared/README.md);
 * [custom env metadata](../env/prompt.mjs) adds active key names/descriptions, never values.
 * [Contract/tests](../../tests/env-description.test.mjs).
 */
export async function buildSystemPrompt({ env = process.env, workspace = workspaceDir(env), extra = '' } = {}) {
  const chunks = [];
  for (const name of FILES) {
    try {
      const text = await fs.readFile(path.join(workspace, name), 'utf8');
      if (text.trim()) chunks.push(`# ${name}\n\n${text.trim()}`);
    } catch {
      /* optional */
    }
  }
  chunks.push(
    [
      '# Runtime',
      `Ты работаешь как личный агент владельца в Telegram через ${profile.resolveProfile(env).codexTitle} open-core.`,
      'Отвечай на русском, если владелец не попросил иное.',
      'Рабочий каталог — workspace сервера. Проекты — в ~/projects/.',
      'Не выдумывай секреты и чужие продукты. На необратимом — спроси.',
    ].join('\n'),
  );
  const capabilities = await envCapabilityPrompt(env);
  if (capabilities) chunks.push(capabilities);
  if (extra) chunks.push(extra);
  return chunks.join('\n\n');
}
