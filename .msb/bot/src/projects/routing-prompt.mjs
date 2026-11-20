/**
 * Agent-facing instructions for free-form project routing setup.
 * Injected by [system-prompt](../agent/system-prompt.mjs); file IO stays with the agent tools.
 */
import { loadProjectRouting } from './routing-load.mjs';
import { ROUTING_MODES, ROUTING_MODE_LABELS } from './routing-modes.mjs';

export function routingAgentManual() {
  const modes = ROUTING_MODES.map(id => `${id} (${ROUTING_MODE_LABELS[id]})`).join(', ');
  return [
    '## Маршрутизация режимов задачи',
    'Владелец может настроить, какой CLI/модель брать для режима работы (не для отрасли).',
    'UI-мастер: /settings → «Маршрутизация задач». Команда смены режима: /type. В сообщении: #make … / #анализ …',
    '',
    'Файл настроек текущего каталога (workspace или выбранный проект):',
    '`<cwd>/.msb/settings.yaml`',
    'Нет файла — маршрутизация выключена. Файл с `routing.enabled: false` тоже выключает применение, но сохраняет карту.',
    '',
    `Режимы (ровно эти): ${modes}.`,
    'Отрасли (дизайн, право, бухгалтерия…) — не отдельные типы; пиши их в aliases → один из пяти режимов.',
    '',
    'Если владелец просит настроить маршрутизацию в диалоге:',
    '1. Уточни текущий cwd (workspace vs проект) и какие провайдеры у него уже подключены.',
    '2. Предложи карту по умолчанию: ask/study/check → claude; make → codex (если есть); run → cursor или claude.',
    '3. Создай каталог `.msb/` при необходимости и запиши валидный `settings.yaml` (version: 1, routing.enabled true|false, routing.default, routing.apply sticky|once, полный routing.types на все 5 режимов).',
    '4. Выключить без удаления: поставь `enabled: false`. Включить снова: `enabled: true`.',
    '5. model/effort: для Claude обычно sonnet/opus + medium/high; для других CLI можно null.',
    '6. Не указывай provider, которого нет в подключении — иначе ход откажет с ошибкой.',
    '7. После записи кратко скажи, как пользоваться: /type, кнопки «Режим», префиксы #…',
    '8. Не подменяй SOUL.md/CLAUDE.md ради маршрутизации — только `.msb/settings.yaml`.',
  ].join('\n');
}

export async function routingCapabilityPrompt({ cwd, env = process.env } = {}) {
  const lines = [routingAgentManual()];
  if (!cwd) return lines.join('\n');
  try {
    const loaded = await loadProjectRouting(cwd);
    if (!loaded) {
      lines.push('', 'Сейчас в этом каталоге файл маршрутизации отсутствует.');
    } else {
      const { routing } = loaded.settings;
      const on = routing.enabled !== false;
      lines.push(
        '',
        `Файл: ${loaded.path}`,
        `enabled=${on}, default=${routing.default}, apply=${routing.apply}`,
        ...ROUTING_MODES.map(mode => {
          const row = routing.types[mode];
          return `- ${mode}: ${row.provider}` +
            (row.model ? ` / ${row.model}` : '') +
            (row.effort ? ` / ${row.effort}` : '');
        }),
      );
    }
  } catch (error) {
    lines.push('', `Файл маршрутизации есть, но не читается: ${error.message || error}`);
  }
  return lines.join('\n');
}
