/** Verify that the disposable profile did not persist a native thread file. */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function assertNoSavedSessions(profile) {
  const visit = async directory => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
      else throw Error('disposable native profile retained a session file');
    }
  };
  await visit(path.join(profile, 'sessions'));
}
