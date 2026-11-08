/** Native --version-only script in a synthetic HOME; never uses an installed CLI. */
import fs from 'node:fs/promises';
import path from 'node:path';
export async function fixtureClaudeVersion(home, version = '2.1.154') {
  const file = path.join(home, 'native-version-fixture.mjs');
  await fs.writeFile(file, `if (process.argv[2] !== '--version') throw Error('Only --version allowed'); process.stdout.write(${JSON.stringify(version + ' (Claude Code)')});`);
  process.env.MSB_REAL_CLAUDE = file;
  return file;
}
