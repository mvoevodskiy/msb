// The core and overlay share one per-profile transaction queue in the bot process.
// Keep this module standalone so the overlay can still load without open-core.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { botStatePath } from './paths.mjs';
const updates = globalThis[Symbol.for('msb.stateUpdates')] ||= new Map();
export function updateBotState(mutator, env = process.env, home = os.homedir()) {
  const file = botStatePath(env, home);
  const previous = updates.get(file) || Promise.resolve();
  const update = previous.catch(() => {}).then(async () => {
    let state;
    try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (err) { if (err?.code !== 'ENOENT') throw err; state = {}; }
    const next = await mutator(state);
    if (next == null) return state;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
    return next;
  });
  updates.set(file, update);
  const release = () => { if (updates.get(file) === update) updates.delete(file); };
  update.then(release, release);
  return update;
}
