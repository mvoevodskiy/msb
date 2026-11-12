import profile from '../../shared/profile.cjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { envCapabilityPrompt } from '../env/prompt.mjs';
import { projectLocations } from '../projects/paths.mjs';
import { workingContext } from '../projects/context.mjs';
import { workspaceDir } from '../paths.mjs';

const FILES = ['SOUL.md', 'CLAUDE.md', 'USER.md', 'MEMORY.md', 'TELEGRAM-TOOLS.md'];

/**
 * Собирает append-system-prompt из workspace (как context-loader закрытого ядра, упрощённо).
 * Навигация: [Исполнение](./README.md) → [profile label](../../shared/README.md);
 * Project-local notes → [working context](../projects/context.mjs), separate from base owner files.
 * [env metadata](../env/prompt.mjs) adds service configuration and custom descriptions, never values.
 * [Service checks](../../tests/env-services.test.mjs), [custom checks](../../tests/env-description.test.mjs).
 */
export async function buildSystemPrompt({ env = process.env, workspace = workspaceDir(env), cwd = workspace, timezone = 'UTC', now = Date.now(), extra = '' } = {}) {
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
      `Рабочий каталог: ${JSON.stringify(cwd)}.`,
      `Базовый workspace: ${JSON.stringify(workspace)}. Проекты: ${JSON.stringify(projectLocations(env,workspace).root)}.`,
      'Файлы .media/* — фото и медиа от клиента, безопасно читать.',
      'Отправка медиа клиенту: [ФОТО: путь], [ФАЙЛ: путь], [СТИКЕР: путь], [ВИДЕО: путь], [АУДИО: путь], [ГОЛОС: путь], [GIF: путь]. Опциональная подпись через пробел после пути. Маркеры убираются из текста ответа и файлы уходят отдельными сообщениями Telegram.',
      'Не выдумывай секреты и чужие продукты. На необратимом — спроси.',
    ].join('\n'),
  );
  const local = await workingContext({cwd,timezone,now});
  if (local) chunks.push(local);
  const capabilities = await envCapabilityPrompt(env);
  if (capabilities) chunks.push(capabilities);
  if (extra) chunks.push(extra);
  return chunks.join('\n\n');
}
