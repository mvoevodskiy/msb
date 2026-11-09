/**
 * Final owner response → [validation](../autonomy/reminder-protocol.mjs) →
 * [per-bot action](../autonomy/reminder-store.mjs). Worker: [bot](./bot.mjs).
 * Checks: [real worker + scheduler](../../tests/one-shot-reminder.test.mjs).
 */
import { loadState } from '../state.mjs';
import { readReminderPolicy, reminderOwnerChat } from '../autonomy/reminder-policy.mjs';
import { addReminder } from '../autonomy/reminder-store.mjs';
import { describeReminderConfirmation, parseReminderMarker } from '../autonomy/reminder-protocol.mjs';
import { escapeHtml } from './edit.mjs';

const marker = /\[SCHEDULE_TASK\]([\s\S]*?)\[\/SCHEDULE_TASK\]/g;
const example = /\x60{3}[\s\S]*?(?:\x60{3}|(?![\s\S]))|\x60[^\x60\r\n]+\x60|^[ \t]*>.*$|<(pre|code|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gim;
const disabled = 'Автономные задачи сейчас выключены.';
const unsupported = 'Фоновую задачу сейчас не ставлю: разовые напоминания на этом движке пока не подключены.';
const noCollector = 'Фоновую задачу сейчас не ставлю: на этом боксе некому вернуть результат, он до тебя не дойдёт.';
const invalid = 'Не понял задачу — повтори, пожалуйста.';
const failed = 'Не удалось поставить задачу.';
const safeText = value => escapeHtml(value)
  .replaceAll('[', '&#91;').replaceAll(']', '&#93;').replaceAll('✔', '&#10004;');

function correctClaim(text) {
  const success = /(?:^|\s)(?:поставил[аи]?|готово)(?=$|[\s.,!])|(?:напоминание|задача)\s+(?:создан[ао]?|сохранен[ао]?|сохранён[ао]?)|буд(?:ет|у|ут)[^.!?…\n]{0,90}?(?:напомина|срабатыва)/iu;
  const qualified = /[?«»"\x60]|(?:^|\s)(?:не|нет|если|когда|скажи|попробуй)(?:$|\s)|ошибк|сбой/iu;
  return text.split(/(?<=[.!?…])(?=\s)|(?<=\n)/u).map(sentence => {
    if (!success.test(sentence) || qualified.test(sentence)) return sentence;
    return sentence.replace(/\S(?:[^\r\n]*\S)?/u, 'Тут я поторопился с обещанием: на деле не вышло, причина рядом.');
  }).join('');
}

async function registrationPolicy(context) {
  const { state } = await loadState();
  const policy = await readReminderPolicy(state);
  if (!policy.enabled) return { error: disabled };
  if (!policy.local || policy.asleep || context.rail !== 'cc') return { error: unsupported };
  if (!reminderOwnerChat(state, context.ownerId)) return { error: noCollector };
  return { ...policy, timezone: state.timezone || context.timezone };
}

async function register(raw, context) {
  try {
    let policy = await registrationPolicy(context);
    if (policy.error) return policy;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return { error: invalid };
    }
    const parsed = parseReminderMarker(value, context);
    if (!parsed.action) return parsed;
    const saved = await addReminder(parsed.action, {
      signal: context.signal,
      async check() {
        policy = await registrationPolicy(context);
        return policy.error;
      },
    });
    if (!saved.action) return saved;
    return { text: describeReminderConfirmation(saved.action, context.now, policy.timezone, policy.stopped) };
  } catch {
    context.signal?.throwIfAborted();
    return { error: failed };
  }
}

export async function processReminderMarkers(text, context) {
  if (typeof text !== 'string' || !text.includes('[SCHEDULE_TASK]')) return text;
  const examples = [...text.matchAll(example)];
  const blocks = [...text.matchAll(marker)].filter(block => !examples.some(range =>
    block.index >= range.index && block.index < range.index + range[0].length));
  if (!blocks.length) return text;

  const parts = [], errors = [];
  let offset = 0, previousFailure = false;
  for (const block of blocks) {
    context.signal?.throwIfAborted();
    const result = context.ownerId && context.ok ? await register(block[1], context) : { text: '(задача не обработана)' };
    const before = text.slice(offset, block.index);
    const correction = previousFailure || (blocks.length === 1 && result.error);
    parts.push(correction ? correctClaim(before) : before);
    offset = block.index + block[0].length;
    previousFailure = Boolean(result.error);
    if (result.error) errors.push('• ' + safeText(result.error));
    parts.push(safeText(result.text || result.error));
  }
  const after = text.slice(offset);
  parts.push(previousFailure ? correctClaim(after) : after);
  const clean = parts.join('').trim();
  return errors.length ? clean + '\n\n⚠ Не выполнено:\n' + errors.join('\n') : clean;
}
