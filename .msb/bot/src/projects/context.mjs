/**
 * Captured cwd → optional current task/day memory/knowledge, supplementing owner
 * context from the base [system prompt](../agent/system-prompt.mjs), never replacing it.
 * Old nHA/uHA/c1: [contract](../../tests/reference/parity-projects-contract.txt).
 * [Execution checks](../../tests/project-execution.test.mjs), [context boundaries](../../tests/project-context.test.mjs).
 * Reads only, no native histories.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export function workingDay(now = Date.now(), timezone = 'UTC') {
  try { return new Intl.DateTimeFormat('sv-SE', {timeZone:timezone, year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(now)); }
  catch { return new Date(now).toISOString().slice(0,10); }
}
function contextText(text) {
  const value = text.replace(/<\/?(?:system|assistant|user|human)(?:\s[^>]*)?>/gi, '')
    .replace(/^(?:system|assistant|human)\s*:/gim, '');
  return value.length > 50000 ? value.slice(0,50000) + '\n[...truncated]' : value;
}
async function localText(cwd, relative) {
  try {
    const [root, file] = await Promise.all([fs.realpath(cwd), fs.realpath(path.join(cwd, relative))]);
    const within = path.relative(root, file);
    if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) return '';
    return contextText(await fs.readFile(file, 'utf8')).trim();
  } catch { return ''; } // Old B0: optional context failures must not block a turn.
}
export async function workingContext({cwd, timezone = 'UTC', now = Date.now()}) {
  const day = workingDay(now, timezone);
  const sources = [['Активная задача','.current-task.md'], ['Заметки за сегодня',`memory/${day}.md`], ['База знаний','knowledge/_index.md']];
  const contents = await Promise.all(sources.map(([,file]) => localText(cwd,file)));
  return contents.flatMap((text,i) => text ? [`## ${sources[i][0]}\n${text}`] : []).join('\n\n');
}
