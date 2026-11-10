/**
 * Owner-defined roles for one saved collection. [Registration](./prompt-registration.mjs)
 * validates input, while existing records feed [task details](../telegram/screens/task-inspection-options.mjs),
 * the [menu card](../telegram/screens/reminders.mjs) and [native launch](./prompt-turn.mjs).
 * [Checks](../../tests/saved-prompt-registration.test.mjs) exercise the stored shape.
 */

const clean = (value, limit) => (value ?? '').trim().replace(/\s+/g, ' ').slice(0, limit).toWellFormed();

export function normalizePromptTeam(value) {
  if (value == null) return { team: [] };
  if (!Array.isArray(value)) return { error: 'команда должна быть списком ролей' };
  const team = [];
  const names = new Set();
  for (const entry of value) {
    const role = typeof entry === 'string' ? { name: entry } : entry ?? {};
    if (role.name !== undefined && typeof role.name !== 'string') return { error: 'имя роли должно быть строкой' };
    if (role.brief !== undefined && typeof role.brief !== 'string') return { error: 'описание роли должно быть строкой' };
    const name = clean(role.name, 40);
    const brief = clean(role.brief, 240);
    if (!name) return { error: 'у каждой роли должно быть имя' };
    if (!brief) return { error: 'у роли «' + name + '» не сказано, что она делает' };
    const key = name.toLowerCase();
    if (names.has(key)) return { error: 'роль «' + name + '» названа дважды' };
    if (team.length >= 4) return { error: 'ролей не больше 4' };
    names.add(key);
    team.push({ name, brief });
  }
  return { team };
}

export function savedPromptTeam(action) {
  const { task } = action;
  if (task?.kind !== 'prompt' || task.helpers === false || !Array.isArray(task.team)) return [];
  return task.team.filter(role =>
    typeof role?.name === 'string' && role.name.trim() && typeof role.brief === 'string' && role.brief.trim());
}

export function promptTeamInstructions(team, provider, claudeIds) {
  if (!team.length) return '';
  const roles = team.map(({ name, brief }, index) =>
    '- ' + name + (claudeIds ? ' (' + claudeIds[index] + ')' : '') + ': ' + brief);
  const delegate = provider === 'codex'
    ? 'Помощника зови через spawn_agent и дожидайся его результата через wait_agent.'
    : 'Помощника зови инструментом делегирования Agent или Task.';
  const role = claudeIds
    ? 'В subagent_type ставь идентификатор роли из скобок.'
    : 'Имя и бриф роли включай в текст поручения.';
  return ['Команда задачи. Каждому помощнику давай его бриф и конкретное поручение, результат проверяй сам.',
    ...roles, delegate + ' ' + role, 'Работу, где помощник не нужен, делай сам.'].join('\n');
}
