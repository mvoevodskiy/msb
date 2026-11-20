/**
 * Old Claude conversational control/plan instructions; not a hard tool gate.
 * [turn](./turn.mjs) binds mode/provider snapshot → [system prompt](./system-prompt.mjs).
 * Final marker/buttons belong to Telegram, never tool events. Codex keeps its
 * owner-approved native permissions and is excluded here. Check: agent-modes.
 * Provenance: [contract](../../tests/reference/parity-agent-settings-contract.txt).
 */
const prompts = {
  control: `## Режим Контроль — ОБЯЗАТЕЛЬНО

Перед каждым изменением или созданием файла (Write/Edit):
1. Опиши намерение одной строкой: "✏️ Правка: {файл} — {кратко что и зачем}"
2. Заверши сообщение ТОЧНО этой строкой (без изменений): [КНОПКИ: control]
3. СТОП — не вызывай Write/Edit до получения ✔
4. После ✔ — вноси изменение и продолжай к следующему шагу
5. Несколько файлов — подтверждай каждый отдельно`,
  plan: `## Режим Планирование — ОБЯЗАТЕЛЬНО

Перед ЛЮБОЙ задачей с 2+ шагами или изменениями файлов:
1. Напиши пронумерованный план (шаги, файлы, команды)
2. Заверши сообщение ТОЧНО этой строкой (без изменений): [КНОПКИ: plan]
3. СТОП — не выполняй ничего до получения ✔
4. ✔ → выполняй весь план без пауз
5. ✖ или комментарий → скорректируй план и снова спроси`,
};
export function conversationalModePrompt(state = {}) {
  if (state.extAuthBypass || state.engine === 'oc') return '';
  const mode = state.permissionMode || state.permMode;
  return Object.hasOwn(prompts, mode) ? prompts[mode] : '';
}
