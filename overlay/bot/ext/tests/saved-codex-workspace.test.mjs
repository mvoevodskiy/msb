/** File tools exposed only to [saved Codex turns](../adapters/saved-codex.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { savedWorkspaceTools } from '../adapters/saved-workspace-tools.mjs';

async function workspace(t, tools) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'msb-file-grants-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  const home = path.join(root, 'home[fixture]');
  const secretDir = path.join(home, '.iia', 'bots', 'default');
  const outside = path.join(root, 'outside.txt');
  const secret = path.join(secretDir, '.env');
  const notes = path.join(home, 'notes.txt');
  const transaction = secret + '.tmp.4242';
  const otherSession = path.join(secretDir, 'sessions', 'other.json');
  const lock = secret + '.lock.sqlite';
  const pendingAction = path.join(secretDir, '.records-test', 'records.json');
  await Promise.all([cwd, path.dirname(otherSession), path.dirname(pendingAction)].map(dir => fs.mkdir(dir, { recursive: true })));
  await Promise.all([
    fs.writeFile(secret, 'fixture-secret'),
    fs.writeFile(transaction, 'pending secret'),
    fs.writeFile(otherSession, 'other session'),
    fs.writeFile(lock, 'lock'),
    fs.writeFile(pendingAction, 'pending action'),
    fs.writeFile(outside, 'outside'),
    fs.writeFile(notes, 'first\nmatch\nlast', { mode: 0o640 }),
    fs.writeFile(path.join(cwd, 'local.txt'), 'a\nb\nc'),
  ]);
  await Promise.all([
    fs.symlink(secret, path.join(cwd, 'alias.txt')),
    fs.link(secret, path.join(cwd, 'hard.txt')),
  ]);
  const scope = { cwd, directories: [home], denied: [path.join(home, '.iia', 'bots', '**', '.env'), path.join(home, '.iia', 'bots', '**', 'sessions', '**'), path.join(secretDir, '.records-*', '**')], tools };
  return { ...await savedWorkspaceTools(scope), cwd, home, secret, transaction, otherSession, lock, pendingAction, outside, notes };
}

test('narrow Codex tools read the old home scope and deny protected paths and writes', async t => {
  const f = await workspace(t, ['Read', 'Glob', 'Grep', 'TodoWrite', 'Bash', 'ToolSearch']);
  assert.deepEqual(f.tools.map(tool => tool.name), ['read_file', 'glob_files', 'grep_files', 'update_todos']);
  assert.equal(await f.call('read_file', { path: 'local.txt', offset: 2, limit: 1 }), 'b');
  assert.match(await f.call('read_file', { path: f.notes }), /match/);
  assert.equal(await f.call('glob_files', { pattern: '**/*.txt', path: f.home }), f.notes);
  assert.equal(await f.call('grep_files', { pattern: '^match$', path: f.home, glob: '*.txt' }), f.notes + ':2:match');
  assert.equal(await f.call('glob_files', { pattern: '**/.env', path: f.home }), '');
  for (const file of [f.outside, f.secret, f.transaction, f.otherSession, f.lock, f.pendingAction, 'alias.txt', 'hard.txt']) {
    await assert.rejects(f.call('read_file', { path: file }), /Доступ к пути запрещён/);
  }
  await assert.rejects(f.call('write_file', { path: 'local.txt', text: 'no' }), /Операция недоступна/);
  assert.equal(await f.call('read_file', { path: 'local.txt' }), 'a\nb\nc');
});

test('standard Codex tools create and edit files without touching protected bytes', async t => {
  const f = await workspace(t, ['Read', 'Write', 'Edit', 'NotebookEdit']);
  await f.call('write_file', { path: 'new.txt', text: 'new' });
  assert.equal(await fs.readFile(path.join(f.cwd, 'new.txt'), 'utf8'), 'new');
  await f.call('edit_file', { path: f.notes, old: 'match', text: 'updated' });
  assert.equal(await fs.readFile(f.notes, 'utf8'), 'first\nupdated\nlast');
  assert.equal((await fs.stat(f.notes)).mode & 0o777, 0o640);
  await assert.rejects(f.call('edit_file', { path: f.notes, old: 'missing', text: 'no' }), /однозначно/);
  const notebook = { cells: [{ id: 'cell', cell_type: 'markdown', source: 'old', metadata: {} }] };
  await f.call('write_file', { path: 'draft.ipynb', text: JSON.stringify(notebook) });
  await f.call('edit_notebook', { path: 'draft.ipynb', cell: 'cell', text: 'new cell' });
  assert.equal(JSON.parse(await f.call('read_file', { path: 'draft.ipynb' })).cells[0].source, 'new cell');
  for (const file of [f.outside, f.secret, f.transaction, f.otherSession, f.lock, f.pendingAction, 'alias.txt', 'hard.txt']) {
    await assert.rejects(f.call('write_file', { path: file, text: 'no' }), /Доступ к пути запрещён/);
  }
  assert.equal(await fs.readFile(f.secret, 'utf8'), 'fixture-secret');
  assert.equal(await fs.readFile(f.transaction, 'utf8'), 'pending secret');
  assert.equal(await fs.readFile(f.outside, 'utf8'), 'outside');
  assert.ok((await fs.readdir(f.cwd)).every(name => !name.startsWith('.msb-prompt-')));
});
