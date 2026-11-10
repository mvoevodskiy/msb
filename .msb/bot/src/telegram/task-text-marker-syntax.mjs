/**
 * Bound old full and compact task text forms in the original reply.
 * The [handler](./task-text-markers.mjs) reserves commands and quoted examples
 * before other processors see their bodies. [Checks](../../tests/task-text-edit.test.mjs).
 */
import { autonomyExample, legacyTimerMarker, literalAutonomyRanges, maskAutonomyRanges, outsideExamples, taskCancelMarker, taskInspectionMarker,
  taskMutationRanges, taskRescheduleMarker } from './autonomy-marker-text.mjs';

const opening = /\[(EDIT_TASK|APPEND_TASK|DROP_FROM_TASK):/g;
const contains = (range, position) => range.index <= position && position < range.index + range[0].length;

function markerRanges(text) {
  return taskMutationRanges(text, [...text.matchAll(taskCancelMarker), ...text.matchAll(taskRescheduleMarker), ...text.matchAll(legacyTimerMarker)]);
}

function fullClose(text, from, tag, following) {
  let position = 0;
  let depth = 1;
  for (let close = text.indexOf(tag, from); close >= 0; close = text.indexOf(tag, close + tag.length)) {
    while (following[position]?.index < close) {
      const nested = following[position++];
      const start = nested.index + nested[0].length;
      const end = text.indexOf(']', start);
      // A compact example needs no closing tag of its own.
      if (end < 0 || !text.slice(start, end).includes('|')) depth++;
    }
    depth--;
    if (depth === 0) return close;
  }
  return -1;
}

function readBlock(text, start, following, literal) {
  const [opener, operation] = start;
  const index = start.index;
  const from = index + opener.length;
  const headerEnd = text.indexOf(']', from);
  const limit = literal ? literal.index + literal[0].length : text.length;
  const malformed = end => ({ 0: text.slice(index, Math.min(end, limit)), index, operation });
  if (headerEnd < 0) return malformed(limit);
  const header = text.slice(from, headerEnd);
  const separator = header.indexOf('|');
  const closeTag = '[/' + operation + ']';
  const fromBody = headerEnd + 1;
  const nested = following.filter(marker => marker.index >= fromBody);
  const firstClose = text.indexOf(closeTag, fromBody);
  const nextSame = nested[0]?.index ?? Infinity;
  // Match the complete syntax before considering quotes in its body.
  // A compact command cannot borrow a later full sibling's closing tag.
  const close = separator >= 0 && nextSame < firstClose ? -1 : fullClose(text, fromBody, closeTag, nested);
  const full = close >= 0;
  if (header.includes('[')) {
    const lineEnd = text.indexOf('\n', headerEnd + 1);
    return malformed(full ? close + closeTag.length : lineEnd < 0 ? text.length : lineEnd);
  }
  if (full) return {
    0: text.slice(index, close + closeTag.length), index, operation, form: 'full',
    query: header, body: text.slice(headerEnd + 1, close),
  };
  if (separator >= 0) return {
    0: text.slice(index, headerEnd + 1), index, operation, form: 'compact',
    query: header.slice(0, separator), body: header.slice(separator + 1),
  };
  // An open multiline payload without its closing tag can contain other doors.
  return malformed(limit);
}

export function taskTextBlocks(text) {
  if (typeof text !== 'string' || !/\[(?:EDIT_TASK|APPEND_TASK|DROP_FROM_TASK):/.test(text)) return [];
  const { payloads, quotes } = markerRanges(text);
  const examples = [...text.matchAll(autonomyExample), ...quotes];
  const starts = [...text.matchAll(opening)];
  const blocks = [];
  for (const [position, start] of starts.entries()) {
    if (blocks.some(block => contains(block, start.index))) continue;
    const enclosing = range => range.index < start.index && contains(range, start.index) &&
      !blocks.some(block => contains(block, range.index));
    if (payloads.some(enclosing)) continue;
    const following = starts.slice(position + 1).filter(other => other[1] === start[1]);
    blocks.push(readBlock(text, start, following, examples.find(enclosing)));
  }
  // A quote in a task body cannot quote a sibling command.
  const literals = literalAutonomyRanges(maskAutonomyRanges(text, blocks.filter(block => block.form)));
  return blocks.map(block => ({ ...block, literal: literals.some(range => contains(range, block.index)) }));
}

export function shownTaskSelectors(text) {
  const { payloads, quotes } = markerRanges(text);
  const outside = payloads.filter(range => !range[0].startsWith('[SHOW_TASK:'));
  return outsideExamples(text, taskInspectionMarker, [...outside, ...quotes])
    .filter(block => block[2] === 'SHOW_TASK').map(block => block[3].trim()).filter(Boolean);
}
