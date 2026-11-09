/**
 * Text-only autonomy marker boundaries and final replacement. Shared by the
 * [reminder](./reminder-markers.mjs) and [pause](./pause-markers.mjs) handlers.
 */
import { escapeHtml } from './edit.mjs';

export const scheduleMarker = /\[SCHEDULE_TASK\]([\s\S]*?)\[\/SCHEDULE_TASK\]/g;
const example = /\x60{3}[\s\S]*?(?:\x60{3}|(?![\s\S]))|\x60[^\x60\r\n]+\x60|«[^»]*»|^[ \t]*>.*$|<(pre|code|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gim;

export function outsideExamples(text, pattern, protectedRanges = []) {
  const examples = [...text.matchAll(example), ...protectedRanges];
  return [...text.matchAll(pattern)].filter(block => !examples.some(range =>
    block.index >= range.index && block.index < range.index + range[0].length));
}

const safeText = value => escapeHtml(value)
  .replaceAll('[', '&#91;').replaceAll(']', '&#93;').replaceAll('✔', '&#10004;');

function correctClaim(text) {
  const success = /(?:^|\s)(?:поставил[аи]?|готово|остановил[аи]?|возобновил[аи]?|снял[аи]?\s+(?:стоп|паузу))(?=$|[\s.,!])|(?:напоминание|задача)\s+(?:создан[ао]?|сохранен[ао]?|сохранён[ао]?)|буд(?:ет|у|ут)[^.!?…\n]{0,90}?(?:напомина|срабатыва)/iu;
  const qualified = /[?«»"\x60]|(?:^|\s)(?:не|нет|если|когда|скажи|попробуй)(?:$|\s)|ошибк|сбой/iu;
  return text.split(/(?<=[.!?…])(?=\s)|(?<=\n)/u).map(sentence => {
    if (!success.test(sentence) || qualified.test(sentence)) return sentence;
    return sentence.replace(/\S(?:[^\r\n]*\S)?/u, 'Тут я поторопился с обещанием: на деле не вышло, причина рядом.');
  }).join('');
}

export async function replaceAutonomyMarkers(text, blocks, apply) {
  if (!blocks.length) return text;
  const parts = [], errors = [];
  let offset = 0, previousFailure = false;
  for (const block of blocks) {
    const result = await apply(block);
    const before = text.slice(offset, block.index);
    const correction = previousFailure || (blocks.length === 1 && result.error);
    parts.push(correction ? correctClaim(before) : before);
    offset = block.index + block[0].length;
    previousFailure = Boolean(result.error);
    if (result.error) errors.push('• ' + safeText(result.error));
    parts.push(safeText(result.text ?? result.error ?? ''));
  }
  const after = text.slice(offset);
  parts.push(previousFailure ? correctClaim(after) : after);
  const clean = parts.join('').trim();
  return errors.length ? clean + '\n\n⚠ Не выполнено:\n' + errors.join('\n') : clean;
}
