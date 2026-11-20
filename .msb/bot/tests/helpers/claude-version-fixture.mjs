/** Native --version-only script in a synthetic HOME; never uses an installed CLI. */
import fs from 'node:fs/promises';
import path from 'node:path';
export async function fixtureClaudeVersion(home, version = '2.1.154') {
  const file = path.join(home, 'native-version-fixture.mjs');
  await fs.writeFile(file, `if (process.argv[2] !== '--version') throw Error('Only --version allowed'); process.stdout.write(${JSON.stringify(version + ' (Claude Code)')});`);
  process.env.MSB_REAL_CLAUDE = file;
  return file;
}

/** Strict process fixtures permit only this one metadata probe; all other execs stay forbidden. */
export function fixtureVersionExec(home, deny, version = '2.1.154') {
  const file = path.join(home, 'native-version-fixture.mjs');
  return (command, args, options, callback) => {
    if (command !== process.execPath || args.length !== 2 || args[0] !== file || args[1] !== '--version'
      || options.env.HOME !== home || options.env.MSB_REAL_CLAUDE !== file) return deny('execFile');
    queueMicrotask(() => callback(null, version + ' (Claude Code)', ''));
  };
}
