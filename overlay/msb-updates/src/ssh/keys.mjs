import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';
import { storePaths } from '../store/paths.mjs';
import { ensureDir } from '../util.mjs';

const execFileAsync = promisify(execFile);

export async function ensureHubKey(dataDir) {
  const p = storePaths(dataDir);
  await ensureDir(p.ssh);
  try {
    await fsp.access(p.sshPrivate);
    await fsp.access(p.sshPublic);
  } catch {
    await execFileAsync('ssh-keygen', [
      '-t', 'ed25519',
      '-f', p.sshPrivate,
      '-N', '',
      '-C', 'msb-updates-hub',
    ]);
    await fsp.chmod(p.sshPrivate, 0o600);
  }
  const pub = (await fsp.readFile(p.sshPublic, 'utf8')).trim();
  return { privateKeyPath: p.sshPrivate, publicKey: pub, publicKeyPath: p.sshPublic };
}
