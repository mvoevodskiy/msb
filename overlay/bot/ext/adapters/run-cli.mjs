import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Запуск CLI: stdout собираем. [Codex](./codex.mjs) также читает стартовую JSONL-запись до закрытия процесса.
 * @param {{forwardStderr?: boolean, onStdoutLine?: (line: string) => void}} opts
 * По умолчанию stderr дублируется в журнал процесса. Для Codex ставь
 * forwardStderr:false, чтобы сырой stderr не попадал в журнал бота.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string}>}
 */
export function runCli(command, args, { cwd, env, input, timeoutMs = 1_800_000, forwardStderr = true, onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      // Не reject: адаптерам нужен частичный stdout/stderr после таймаута.
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        if (!settled) {
          settled = true;
          resolve({ code: null, stdout, stderr, timedOut: true });
        }
      }, 5_000);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    if (onStdoutLine) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', line => {
        if (!settled) onStdoutLine(line);
      });
    }
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (forwardStderr) process.stderr.write(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });

    if (input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/** Первый исполняемый `bin` в PATH, кроме нашего shim-каталога. */
export function findBin(bin, env = process.env) {
  const pathEnv = env.PATH || '';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = `${dir.replace(/\/$/, '')}/${bin}`;
    if (candidate.includes('/ext/shim/bin/')) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* continue */
    }
  }
  return null;
}
