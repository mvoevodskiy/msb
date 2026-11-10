/**
 * Ordinary conversational collection from [SCHEDULE_TASK](./reminder-protocol.mjs).
 * Normalize the work body and old authority before [local plan admission](./prompt-policy.mjs).
 * [Telegram](../telegram/reminder-markers.mjs) publishes the action and reports its permissions.
 * [Checks](../../tests/saved-prompt-registration.test.mjs).
 */
import { savedClaudeHelpersSupported } from './saved-claude-helpers.mjs';
import { ordinarySavedPrompt } from './prompt-policy.mjs';

const prefixes = [
  /^\s*(?:поставь|заведи|создай|сделай|добавь)\s+(?:мне\s+)?(?:пожалуйста\s+)?(?:фоновую\s+|новую\s+)?задачу(?![а-яё])[^.:;!?\n]*[.:;!?]?\s*/i,
  /^\s*через\s+(?:\d+|полтора|пол|несколько|пару)\s*[а-яё]*\s*[,.:;–—-]?\s*/i,
  /^\s*кажд(?:ый|ое|ую)\s+[а-яё]+(?:\s+в\s+\d{1,2}(?::\d{2})?)?\s*[,.:;–—-]?\s*/i,
  /^\s*(?:ежедневно|еженедельно|ежечасно|раз\s+в\s+[а-яё]+)\s*[,.:;–—-]?\s*/i,
];
const anotherTask = /\[schedule_task\]|(?:^|[^а-яё])(?:поставь|поставить|заведи|завести|создай|создать|добавь|добавить)\s+(?:мне\s+)?(?:пожалуйста\s+)?(?:фоновую\s+|новую\s+|ещё\s+одну\s+)?задач/i;
const nested = 'Не поставил: в текст задачи попала просьба ПОСТАВИТЬ задачу, а не сама работа. ' +
  'В назначенный час такая задача просто заведёт следующую. Скажи одной фразой, что именно нужно сделать в этот момент.';
export const unsupportedPromptRegistration = 'Не получилось: этот режим сбора пока не подключён.';

export const scheduledPromptInstruction = 'Для обычного сбора по времени тоже используй SCHEDULE_TASK. ' +
  'Раздели время и саму работу. В task.prompt передай инструкцию владельца целиком, начиная с глагола работы.\n' +
  '[SCHEDULE_TASK]{"trigger":{"kind":"recurring","cron":"0 20 * * *"},"task":{"kind":"prompt","prompt":"Собери краткую сводку по заметкам за день."}}[/SCHEDULE_TASK]\n' +
  'Для разового сбора используй trigger.kind="once". При явной просьбе можно указать quiet:true в корне ' +
  'для тишины, task.helpers:false для работы без помощников и maxMinutes в минутах. ' +
  'Этот маршрут выполняет обычный сбор без команд и без памяти между запусками.\n';

export function savedWorkBody(value) {
  let body = value;
  for (let pass = 0; pass < 3; pass++) {
    const before = body;
    for (const prefix of prefixes) body = body.replace(prefix, '');
    if (body === before) break;
  }
  body = body.trim();
  return body.length < 12 ? value : body;
}

export function asksToScheduleAnotherTask(text) {
  return anotherTask.test(text);
}

export function parsePromptRegistration(marker) {
  const { task } = marker;
  // The original marker derives authority and delivery itself. Refuse explicit
  // modes the ordinary runner cannot honor instead of saving a weaker substitute.
  const malformedLists = [task.team, task.bashAllow, task.sources].some(value => value != null && !Array.isArray(value));
  if (!ordinarySavedPrompt(marker) || malformedLists || task.followUp || task.provider != null || task.model != null ||
      marker.authority != null || (marker.capability != null && marker.capability !== 'read') ||
      marker.budget != null || marker.output?.deliverTo || marker.output?.emptyIsValidOutcome ||
      (marker.runner != null && !['auto', 'cc'].includes(marker.runner)) ||
      (marker.helpers != null && marker.helpers !== task.helpers) ||
      (task.helpers != null && typeof task.helpers !== 'boolean')) return { error: unsupportedPromptRegistration };

  const source = task.prompt ?? task.text ?? task.topic;
  const raw = typeof source === 'string' ? source.trim() : '';
  if (!raw) return { error: 'Не получилось: для задачи-запроса нужен текст инструкции' };
  const prompt = savedWorkBody(raw);
  if (asksToScheduleAnotherTask(prompt)) return { error: nested };
  const rawMinutes = marker.maxMinutes;
  const minutes = typeof rawMinutes === 'number' || typeof rawMinutes === 'string' ? Number(rawMinutes) : NaN;
  return {
    task: { kind: 'prompt', prompt, ...(typeof task.helpers === 'boolean' ? { helpers: task.helpers } : {}) },
    authority: { profile: 'standard', whatNotToDo: ['не публиковать ничего автоматически'] },
    capability: 'read',
    ...(marker.quiet === true ? { output: { emptyIsValidOutcome: true } } : {}),
    ...(Number.isFinite(minutes) && minutes > 0
      ? { budget: { maxRunSeconds: Math.min(60, Math.max(1, Math.round(minutes))) * 60 } } : {}),
  };
}

export async function promptRegistrationReady(provider, checkSavedCodex, env = process.env) {
  if (provider !== 'codex') return provider === 'claude';
  try { return await checkSavedCodex?.(env) === true; }
  catch { return false; }
}

export async function promptRegistrationPermissions(action, provider) {
  if (action.task.kind !== 'prompt') return '';
  const base = ' Она сможет читать и сохранять файлы у тебя на сервере. Команды запускать не будет, наружу ничего не публикуется.';
  if (action.task.helpers !== true) return base;
  const canDescribeHelpers = provider === 'codex' || await savedClaudeHelpersSupported();
  return canDescribeHelpers ? base +
    ' Ей можно звать помощников: их права те же, что у неё самой, но ход выходит длиннее и дороже.' : base;
}
