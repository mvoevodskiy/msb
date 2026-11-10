/**
 * Translate old Read/Glob/Grep and Write/Edit/NotebookEdit grants into the
 * [saved Codex MCP server](./saved-workspace-mcp.mjs). All files go through
 * the same [path boundary](./saved-workspace-files.mjs).
 */
import { savedWorkspaceFiles } from './saved-workspace-files.mjs';

const string = { type: 'string' };
const integer = { type: 'integer', minimum: 1 };
const file = { path: string };
const descriptions = {
  Read: ['read_file', 'Read lines of a text file. Offset starts at 1.', { ...file, offset: integer, limit: integer }, ['path']],
  Glob: ['glob_files', 'Find files under a directory by relative glob pattern.', { ...file, pattern: string }, ['pattern']],
  Grep: ['grep_files', 'Find lines matching a regular expression in files.', { ...file, pattern: string, glob: string }, ['pattern']],
  Write: ['write_file', 'Create or replace a text file.', { ...file, text: string }, ['path', 'text']],
  Edit: ['edit_file', 'Replace an exact string in a text file.', { ...file, old: string, text: string,
    all: { type: 'boolean' } }, ['path', 'old', 'text']],
  NotebookEdit: ['edit_notebook', 'Edit a Jupyter cell by zero-based index or cell id.', { ...file, cell: { type: ['integer', 'string'] },
    mode: { enum: ['replace', 'insert', 'delete'] }, cell_type: { enum: ['code', 'markdown'] }, text: string }, ['path', 'cell']],
  TodoWrite: ['update_todos', 'Update the private checklist for this run.', { todos: { type: 'array',
    items: { type: 'object', properties: { text: string, status: { enum: ['pending', 'in_progress', 'completed'] } },
      required: ['text', 'status'], additionalProperties: false } } }, ['todos']],
};

export function savedWorkspaceToolNames(grants) {
  return grants.filter(grant => Object.hasOwn(descriptions, grant)).map(grant => descriptions[grant][0]);
}

function replaceText(original, { old, text, all }) {
  if (typeof old !== 'string' || !old || typeof text !== 'string') throw new Error('Укажите исходный и новый текст.');
  const first = original.indexOf(old);
  if (first < 0 || (!all && original.indexOf(old, first + old.length) !== -1)) {
    throw new Error('Исходный текст должен однозначно совпадать с содержимым файла.');
  }
  return all ? original.split(old).join(text) : original.slice(0, first) + text + original.slice(first + old.length);
}

function editNotebook(original, { cell, mode = 'replace', cell_type, text = '' }) {
  const notebook = JSON.parse(original);
  if (!Array.isArray(notebook.cells)) throw new Error('Файл не содержит ячеек Jupyter.');
  const index = typeof cell === 'string' ? notebook.cells.findIndex(row => row.id === cell) : cell;
  if (!Number.isInteger(index) || index < 0 || index > notebook.cells.length ||
      (mode !== 'insert' && index === notebook.cells.length) ||
      !['replace', 'insert', 'delete'].includes(mode) || typeof text !== 'string') throw new Error('Укажите существующую ячейку и действие.');
  if (mode === 'delete') notebook.cells.splice(index, 1);
  else if (mode === 'insert') {
    const type = cell_type === 'markdown' ? 'markdown' : 'code';
    notebook.cells.splice(index, 0, { cell_type: type, metadata: {}, source: text,
      ...(type === 'code' ? { execution_count: null, outputs: [] } : {}) });
  } else notebook.cells[index].source = text;
  return JSON.stringify(notebook, null, 1) + '\n';
}

function todos(value) {
  if (!Array.isArray(value) || value.length > 40 || value.some(row => typeof row?.text !== 'string' ||
      !['pending', 'in_progress', 'completed'].includes(row.status))) throw new Error('Укажите список задач и их состояния.');
  return JSON.stringify(value.map(row => ({ text: row.text.slice(0, 500), status: row.status })));
}

export async function savedWorkspaceTools(scope) {
  const files = await savedWorkspaceFiles(scope);
  const tools = scope.tools.filter(grant => Object.hasOwn(descriptions, grant)).map(grant => {
    const [name, description, properties, required] = descriptions[grant];
    return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
  });
  const calls = {
    async read_file({ path, offset = 1, limit = 2000 }) {
      if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1) {
        throw new Error('Ожидаются положительные номера строк.');
      }
      const lines = (await files.read(path)).split('\n');
      return lines.slice(offset - 1, offset - 1 + Math.min(limit, 2000)).join('\n').slice(0, 100_000);
    },
    async glob_files({ path = '.', pattern }) {
      const rows = [];
      for await (const file of files.scan(path, pattern)) {
        rows.push(file);
        if (rows.length === 200) break;
      }
      return rows.join('\n');
    },
    async grep_files({ path = '.', pattern, glob }) {
      if (typeof pattern !== 'string' || pattern.length > 512) throw new Error('Укажите регулярное выражение.');
      const regex = new RegExp(pattern, 'u');
      const rows = [];
      let filesRead = 0;
      for await (const file of files.scan(path, glob)) {
        const contents = await files.read(file).catch(() => undefined);
        if (contents === undefined) continue;
        const lines = contents.split('\n');
        for (const [index, line] of lines.entries()) {
          if (regex.test(line)) rows.push(file + ':' + (index + 1) + ':' + line.slice(0, 500));
          if (rows.length === 150) return rows.join('\n');
        }
        if (++filesRead === 3000) break;
      }
      return rows.join('\n');
    },
    write_file: args => files.write(args.path, () => args.text),
    edit_file: args => files.write(args.path, text => replaceText(text, args), true),
    edit_notebook: args => files.write(args.path, text => editNotebook(text, args), true),
    update_todos: args => todos(args.todos),
  };
  return { tools, async call(name, args) {
    if (!tools.some(tool => tool.name === name)) throw new Error('Операция недоступна для этой задачи.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Ожидаются параметры операции.');
    return calls[name](args);
  } };
}
