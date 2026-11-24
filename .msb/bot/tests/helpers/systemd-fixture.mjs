/** Isolated systemctl show fixture for status menus and detached refresh. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function fixtureSystemd(t, units = {}) {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-systemd-fixture-'));
  const previousPath = process.env.PATH;
  const fixturePath = [bin, previousPath ?? '/usr/bin:/bin'].join(path.delimiter);
  process.env.PATH = fixturePath;
  t.after(async () => {
    if (process.env.PATH === fixturePath) {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    await fs.rm(bin, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(bin, 'systemctl'), [
    '#!' + process.execPath,
    'const units = ' + JSON.stringify(units) + ';',
    'const id = process.argv.at(-1);',
    'if (process.argv[2] !== "show" || !Object.hasOwn(units, id)) process.exit(1);',
    'const state = units[id];',
    'console.log("Id=" + id);',
    'console.log("LoadState=" + (state === "not-found" ? "not-found" : "loaded"));',
    'console.log("ActiveState=" + (state === "not-found" ? "inactive" : state));',
    'if (state === "not-found") process.exitCode = 1;',
  ].join('\n') + '\n', { mode: 0o700 });
}
