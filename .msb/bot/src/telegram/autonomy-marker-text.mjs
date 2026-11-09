/**
 * Text-only autonomy marker boundaries and final replacement. Shared by the
 * [reminder](./reminder-markers.mjs), [pause](./pause-markers.mjs) and
 * [limit](./limit-markers.mjs), [inspection](./task-inspection-markers.mjs) and
 * [task control](./task-control-markers.mjs) handlers.
 */
import { escapeHtml } from './edit.mjs';

export const scheduleMarker = /\[SCHEDULE_TASK\]([\s\S]*?)\[\/SCHEDULE_TASK\]/g;
export const limitMarker = /\[SET_LIMIT\s+([^\]]+)\]/g;
export const taskControlMarker = /\[(PAUSE_TASK|RESUME_TASK):([^\]\r\n]*)\]/g;
export const taskInspectionMarker = /\[(LIST_TASKS)\]|\[(SHOW_TASK):([^\]\r\n]*)\]/g;
const example = /\x60{3}[\s\S]*?(?:\x60{3}|(?![\s\S]))|\x60[^\x60\r\n]+\x60|«[^»]*»|^[ \t]*>.*$|<(pre|code|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gim;

export function outsideExamples(text, pattern, protectedRanges = []) {
  const examples = [...text.matchAll(example), ...protectedRanges];
  return [...text.matchAll(pattern)].filter(block => !examples.some(range =>
    block.index >= range.index && block.index < range.index + range[0].length));
}

const safeText = value => escapeHtml(value)
  .replaceAll('[', '&#91;').replaceAll(']', '&#93;').replaceAll('✔', '&#10004;');

const explanations = {
  failed: 'Тут я поторопился с обещанием: на деле не вышло, причина рядом.',
  pending: 'Тут я поторопился: это ещё не сделано, рядом видно, чего я жду.',
};

const actionClaim = /(?:^|\s)(?:поставил[аи]?|готово|остановил[аи]?|возобновил[аи]?|снял[аи]?\s+(?:стоп|паузу))(?=$|[\s.,!])|(?:напоминание|задача)\s+(?:создан[ао]?|сохранен[ао]?|сохранён[ао]?)|буд(?:ет|у|ут)[^.!?…\n]{0,90}?(?:напомина|срабатыва)/iu;

const uncertainty = /\?|(?:^|\s)(?:не|нет|если|когда|скажи|попробуй)(?:$|\s)|ошибк|сбой/iu;
const anyQuote = /[«»"\x60]/u;

function correctClaim(text, status, claim, quoteGuard) {
  return text.split(/(?<=[.!?…])(?=\s)|(?<=\n)/u).map(sentence => {
    if (!claim.test(sentence) || uncertainty.test(sentence) || quoteGuard.test(sentence)) return sentence;
    return sentence.replace(/\S(?:[^\r\n]*\S)?/u, explanations[status]);
  }).join('');
}

export async function replaceAutonomyMarkers(text, blocks, apply, {
  claim = actionClaim, correctLeading = blocks.length === 1, correctBeforeEach = false, quoteGuard = anyQuote,
} = {}) {
  if (!blocks.length) return text;
  const parts = [], errors = [];
  let offset = 0, previousStatus;
  for (const block of blocks) {
    const result = await apply(block);
    const before = text.slice(offset, block.index);
    const status = result.error ? 'failed' : result.awaitingConfirmation ? 'pending' : undefined;
    const correction = correctBeforeEach ? status : previousStatus || (offset === 0 && correctLeading && status);
    parts.push(correction ? correctClaim(before, correction, claim, quoteGuard) : before);
    offset = block.index + block[0].length;
    previousStatus = status;
    if (result.error) errors.push('• ' + safeText(result.error));
    if (result.fragments) {
      parts.push(...result.fragments.map(({ text, verbatim }) => {
        const safe = safeText(text);
        return verbatim ? '<pre>' + safe + '</pre>' : safe;
      }));
    } else {
      parts.push(safeText(result.text ?? result.error ?? ''));
    }
  }
  const after = text.slice(offset);
  parts.push(previousStatus ? correctClaim(after, previousStatus, claim, quoteGuard) : after);
  const clean = parts.join('').trim();
  return errors.length ? clean + '\n\n⚠ Не выполнено:\n' + errors.join('\n') : clean;
}
