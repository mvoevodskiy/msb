/**
 * Raw-preserving per-bot env lines + nearest old #description ownership.
 * [Store](./store.mjs) owns validation/queue/IO; this module never sees a HOME.
 * [Description contract/tests](../../tests/reference/parity-env-description-contract.txt),
 * [regression](../../tests/env-description.test.mjs).
 */
export function inspectEnvLines(lines) {
  const rows = [], map = new Map(), comments = new Map();
  let note;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) { note = {index, text:trimmed.slice(1).trim()}; return; }
    const eq = line.indexOf('=');
    if (!trimmed || eq <= 0) { note = undefined; return; }
    const key = line.slice(0, eq), value = line.slice(eq + 1);
    rows.push({key, value, index, commentIndex:note?.index, comment:note?.text || undefined});
    map.set(key, value);
    if (note?.text) comments.set(key, note.text); else comments.delete(key);
    note = undefined;
  });
  return { rows, map, comments };
}

export function replaceEnvValue(lines, key, value, comment) {
  const rows = inspectEnvLines(lines).rows.filter(row => row.key === key);
  const next = lines.slice(), insert = new Map();
  for (const row of rows) {
    next[row.index] = `${key}=${value}`;
    if (comment !== undefined) {
      if (row.commentIndex !== undefined) next[row.commentIndex] = comment ? `# ${comment}` : '';
      else if (comment) insert.set(row.index, `# ${comment}`);
    }
  }
  if (!rows.length) {
    while (next.length && next.at(-1) === '') next.pop();
    if (comment) next.push(`# ${comment}`);
    next.push(`${key}=${value}`);
  }
  return next.flatMap((line, index) => insert.has(index) ? [insert.get(index), line] : [line]);
}

export function removeEnvValue(lines, key) {
  const next = lines.slice();
  for (const row of inspectEnvLines(lines).rows) {
    if (row.key !== key) continue;
    // Blank separators preserve unrelated raw notes without attaching them to
    // the next key after removing this row and its own last #description.
    next[row.index] = '';
    if (row.commentIndex !== undefined) next[row.commentIndex] = '';
  }
  return next;
}
