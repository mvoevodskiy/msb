import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createSshRunner({ privateKeyPath, strictHostKey = true }) {
  function baseArgs(host, port, user) {
    const args = [
      '-i', privateKeyPath,
      '-p', String(port || 22),
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'ConnectTimeout=15',
      '-o', strictHostKey ? 'StrictHostKeyChecking=accept-new' : 'StrictHostKeyChecking=no',
      `${user}@${host}`,
    ];
    return args;
  }

  async function run(host, { port = 22, user = 'client', command, timeoutMs = 120000, stdin = null }) {
    const args = [...baseArgs(host, port, user), command];
    if (stdin != null) return runWithStdin(args, stdin, timeoutMs);
    try {
      const { stdout, stderr } = await execFileAsync('ssh', args, {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LANG: 'C' },
      });
      return { ok: true, stdout: stdout || '', stderr: stderr || '' };
    } catch (err) {
      return {
        ok: false,
        code: err.code || err.status || null,
        stdout: err.stdout?.toString?.() || '',
        stderr: err.stderr?.toString?.() || String(err.message || err),
      };
    }
  }

  function runWithStdin(args, stdin, timeoutMs) {
    return new Promise((resolve) => {
      const child = spawn('ssh', args, { env: { ...process.env, LANG: 'C' } });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: String(err.message || err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, code, stdout, stderr });
      });
      child.stdin.end(stdin);
    });
  }

  async function probe(host, opts = {}) {
    return run(host, { ...opts, command: 'echo MSB_SSH_OK; whoami; hostname; test -d "$HOME/.msb" && echo HAS_MSB || echo NO_MSB' });
  }

  async function uploadBytes(host, opts, remotePath, content) {
    const tmp = path.join(os.tmpdir(), `msb-up-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fsp.writeFile(tmp, content);
    try {
      const args = [
        '-i', privateKeyPath,
        '-P', String(opts.port || 22),
        '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'ConnectTimeout=15',
        tmp,
        `${opts.user || 'client'}@${host}:${remotePath}`,
      ];
      await execFileAsync('scp', args, { timeout: 120000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, stderr: String(err.stderr || err.message || err) };
    } finally {
      await fsp.unlink(tmp).catch(() => {});
    }
  }

  return { run, probe, uploadBytes };
}
