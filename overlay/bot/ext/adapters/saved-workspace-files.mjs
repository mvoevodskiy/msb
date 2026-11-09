/**
 * Filesystem boundary for [saved prompt tools](./saved-workspace-tools.mjs).
 * The old action workspace, home and temp are eligible. Logical paths, real
 * paths and opened descriptors must all stay outside protected profile files.
 */
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const limit = 2 * 1024 * 1024;
const under = (file, root) => file === root || file.startsWith(root === path.sep ? root : root + path.sep);
const blocked = () => new Error('Доступ к пути запрещён.');
const transactionName = (name, base) => name === base || name === base + '.tmp' ||
  name.startsWith(base + '.tmp.') || name.startsWith(base + '.lock.');
function isProtected(file, rule) {
  const [root, tail] = rule.split('/**/');
  if (tail !== undefined) {
    if (!under(file, root)) return false;
    const segments = path.relative(root, file).split(path.sep);
    return tail.endsWith('/**') ? segments.includes(tail.slice(0, -3))
      : segments.some(segment => transactionName(segment, tail));
  }
  if (rule.endsWith('/.records-*/**')) {
    const directory = path.dirname(path.dirname(rule));
    return under(file, directory) && path.relative(directory, file).startsWith('.records-');
  }
  if (rule.endsWith('/**')) return under(file, rule.slice(0, -3));
  if (rule.endsWith('/*.json*')) {
    return path.dirname(file) === path.dirname(rule) && path.matchesGlob(path.basename(file), '*.json*');
  }
  return under(file, rule) ||
    (path.dirname(file) === path.dirname(rule) && transactionName(path.basename(file), path.basename(rule)));
}
const missing = error => error.code === 'ENOENT';

export async function savedWorkspaceFiles({ cwd, directories, denied, signal, beforeCommit }) {
  const originalRoots = [cwd, ...directories].map(directory => path.resolve(directory));
  const roots = [...originalRoots, ...await Promise.all(originalRoots.map(root => fs.realpath(root)))];
  const allowed = file => roots.some(root => under(file, root)) && !denied.some(rule => isProtected(file, rule));
  function check(file) {
    if (!allowed(file)) throw blocked();
    return file;
  }

  async function locate(input, creating = false) {
    if (typeof input !== 'string' || !input || input.includes('\0')) throw blocked();
    const logical = check(path.resolve(cwd, input));
    let real;
    try {
      real = await fs.realpath(logical);
    } catch (error) {
      if (!creating || !missing(error)) throw error;
      const existing = await fs.lstat(logical).catch(error => {
        if (!missing(error)) throw error;
      });
      if (existing) throw blocked();
      real = path.join(await fs.realpath(path.dirname(logical)), path.basename(logical));
    }
    return check(real);
  }

  async function descriptor(handle, expected) {
    const address = process.platform === 'linux' ? '/proc/self/fd/' + handle.fd : expected;
    if (check(await fs.realpath(address)) !== expected) throw blocked();
    const current = await fs.stat(address);
    const opened = await handle.stat();
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw blocked();
    return { address, opened };
  }

  async function readAt(file, expected = file) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const { opened } = await descriptor(handle, expected);
      if (!opened.isFile() || opened.nlink !== 1) throw blocked();
      if (opened.size > limit) throw new Error('Файл превышает лимит чтения.');
      const bytes = Buffer.alloc(opened.size + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead !== opened.size) throw new Error('Файл изменился во время чтения.');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead)); }
      catch { throw new Error('Поддерживаются только текстовые файлы UTF-8.'); }
      if (text.includes('\0')) throw new Error('Поддерживаются только текстовые файлы UTF-8.');
      return { text, opened };
    } finally {
      await handle.close();
    }
  }

  async function read(input) {
    return (await readAt(await locate(input))).text;
  }

  async function write(input, change, existingOnly = false) {
    signal?.throwIfAborted();
    const target = await locate(input, !existingOnly);
    const parent = path.dirname(target);
    const folder = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let temp;
    try {
      const { address } = await descriptor(folder, parent);
      const file = path.join(address, path.basename(target));
      const previous = await readAt(file, target).catch(error => {
        if (existingOnly || !missing(error)) throw error;
      });
      const value = change(previous?.text);
      if (typeof value !== 'string' || Buffer.byteLength(value) > limit || value.includes('\0')) {
        throw new Error('Ожидается текст не более 2 МиБ.');
      }
      temp = path.join(address, '.msb-prompt-' + randomUUID());
      const mode = previous ? previous.opened.mode & 0o777 : 0o600;
      await fs.writeFile(temp, value, { flag: 'wx', mode });
      await descriptor(folder, parent);
      if (previous) {
        const now = await fs.lstat(file);
        const old = previous.opened;
        if (!now.isFile() || now.nlink !== 1 || now.dev !== old.dev || now.ino !== old.ino ||
            now.size !== old.size || now.mtimeMs !== old.mtimeMs || now.ctimeMs !== old.ctimeMs) {
          throw new Error('Файл изменился во время операции.');
        }
        await fs.chmod(temp, mode);
      }
      signal?.throwIfAborted();
      await beforeCommit?.();
      signal?.throwIfAborted();
      if (previous) {
        await fs.rename(temp, file);
        temp = undefined;
      } else {
        await fs.link(temp, file);
      }
      return target;
    } finally {
      try {
        if (temp) await fs.rm(temp, { force: true });
      } finally {
        await folder.close();
      }
    }
  }

  async function* scan(input, pattern = '**/*') {
    if (typeof pattern !== 'string' || !pattern || path.isAbsolute(pattern) || pattern.split('/').includes('..')) {
      throw new Error('Ожидается относительный шаблон файлов.');
    }
    const base = await locate(input);
    const info = await fs.stat(base);
    if (info.isFile()) {
      if (path.matchesGlob(path.basename(base), pattern)) yield base;
      return;
    }
    if (!info.isDirectory()) return;
    const queue = [base];
    const maxDepth = pattern.includes('**') ? Infinity : pattern.split('/').length;
    let visited = 0;
    for (let index = 0; index < queue.length; index++) {
      const directory = queue[index];
      const folder = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const { address } = await descriptor(folder, directory);
        const entries = await fs.opendir(address);
        for await (const entry of entries) {
          if (++visited > 30_000) throw new Error('Уточните каталог или шаблон поиска.');
          const file = path.join(directory, entry.name);
          if (!allowed(file)) continue;
          const relative = path.relative(base, file);
          if (entry.isDirectory() && relative.split(path.sep).length < maxDepth) queue.push(file);
          if (entry.isFile() && path.matchesGlob(relative, pattern)) yield file;
        }
      } finally {
        await folder.close();
      }
    }
  }

  return { read, write, scan };
}
