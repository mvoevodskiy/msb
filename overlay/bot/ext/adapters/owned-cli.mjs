/**
 * One owned CLI process group for a background turn. [Saved Codex](./saved-codex.mjs)
 * awaits cleanup before handing the result back to the scheduler.
 */
import { spawn } from 'node:child_process';

const outputLimit = 16 * 1024 * 1024;

export function runOwnedCli(command, args, { cwd, env, input, signal }) {
  if (signal.aborted) return Promise.resolve({ aborted: true, stdout: '' });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '', bytes = 0, stopping = false, tooLarge = false, closed = false;
    let term, kill, cleanup;
    function signalGroup(name) {
      if (!child.pid) return;
      try { process.kill(-child.pid, name); }
      catch (error) {
        if (error.code !== 'ESRCH' && child.exitCode == null && child.signalCode == null) {
          try { child.kill(name); } catch { /* already closing */ }
        }
      }
    }
    function release() {
      if (closed) return false;
      closed = true;
      clearTimeout(term);
      clearTimeout(kill);
      clearTimeout(cleanup);
      signal.removeEventListener('abort', stop);
      return true;
    }
    function stop() {
      if (closed || stopping) return;
      stopping = true;
      signalGroup('SIGINT');
      term = setTimeout(() => signalGroup('SIGTERM'), 500);
      kill = setTimeout(() => signalGroup('SIGKILL'), 1500);
      cleanup = setTimeout(() => {
        if (!release()) return;
        child.stdin.destroy();
        child.stdout.destroy();
        child.unref();
        reject(new Error('Background CLI did not close after termination'));
      }, 3000);
    }

    child.stdout.setEncoding('utf8').on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= outputLimit) stdout += chunk;
      else {
        tooLarge = true;
        stop();
      }
    });
    child.stdin.on('error', () => {});
    child.once('error', error => {
      if (release()) reject(error);
    });
    child.once('close', code => {
      if (!release()) return;
      // Once the leader closes, also terminate any remaining descendants of this invocation.
      signalGroup('SIGKILL');
      resolve({ code, stdout, aborted: signal.aborted, tooLarge });
    });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdin.end(input);
  });
}
