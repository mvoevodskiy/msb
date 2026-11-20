// Read-only Codex account telemetry. Never starts/resumes a turn or reads native conversations.
// Contract: https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt
import { spawn } from 'node:child_process';
import type { Subscription } from '../../shared/types.ts';

type Window = { usedPercent: number; windowDurationMins: number; resetsAt: number };
function windowOf(x: unknown): Window | null {
  if (!x || typeof x !== 'object') return null;
  const w = x as Record<string, unknown>;
  return typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100
    && Number.isSafeInteger(w.windowDurationMins) && Number(w.windowDurationMins) > 0
    && Number.isSafeInteger(w.resetsAt) && Number(w.resetsAt) > 0 ? w as Window : null;
}
export function codexSubscription(result: unknown, nowMs: number): Subscription {
  const data = result as { rateLimits?: unknown; rateLimitsByLimitId?: Record<string, unknown>; ordinaryUsageAllowed?: boolean } | null;
  const raw = (data?.rateLimitsByLimitId?.codex ?? data?.rateLimits) as Record<string, unknown> | undefined;
  if (!raw || (raw.limitId != null && raw.limitId !== 'codex')) throw new Error('Codex не вернул окно своей подписки');
  const windows = [windowOf(raw.primary), windowOf(raw.secondary)].filter((w): w is Window => w !== null);
  if (!windows.length) throw new Error('Codex не вернул измеренные лимиты подписки');
  const current = windows.filter(w => w.resetsAt * 1000 > nowMs);
  const worst = (current.length ? current : windows).reduce((a, b) => b.usedPercent > a.usedPercent || (b.usedPercent === a.usedPercent && b.resetsAt > a.resetsAt) ? b : a);
  const denied = data?.ordinaryUsageAllowed === false || (typeof raw.rateLimitReachedType === 'string' && raw.rateLimitReachedType.length > 0);
  return { providerId: 'codex', status: denied || worst.usedPercent >= 100 ? 'limited' : 'allowed',
    resetsAt: new Date(worst.resetsAt * 1000).toISOString(), windowType: null, overage: false,
    updatedAt: new Date(nowMs).toISOString(),
    windows: windows.map(w => ({ usedPercent: w.usedPercent, windowMinutes: w.windowDurationMins,
      resetsAt: new Date(w.resetsAt * 1000).toISOString() })) };
}

/** Stdio JSON-RPC: initialize → read limits → terminate. No OAuth/token material returned. */
export function readCodexLimits(command: string, env: NodeJS.ProcessEnv, timeoutMs = 12_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false, buf = '', bytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.stdin.destroy(); child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex: таймаут чтения лимитов')), timeoutMs);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdin.on('error', () => finish(new Error('Codex: канал лимитов закрыт')));
    child.on('error', () => finish(new Error('Codex CLI недоступен для чтения лимитов')));
    child.on('close', () => { clearTimeout(killTimer); if (!settled) finish(new Error('Codex завершился без лимитов')); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return finish(new Error('Codex: слишком большой ответ лимитов'));
      buf += chunk.toString('utf8');
      let nl;
      while (!settled && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
        if (msg.id === 1) {
          if (msg.error) return finish(new Error('Codex: инициализация чтения лимитов отклонена'));
          send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' });
        } else if (msg.id === 2) {
          if (msg.error) return finish(new Error('Codex: лимиты подписки недоступны'));
          return finish(null, msg.result);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'pult_quota', version: '1' } } });
  });
}

/** Shared CLI account, not per-bot quota. Failures keep the old timestamp and mark stale. */
export class CodexQuota {
  private nextAt = 0;
  private cached: Subscription | null = null;
  private error: string | null = null;
  private readonly read: () => Promise<unknown>;
  constructor(read: () => Promise<unknown>) { this.read = read; }
  async get(nowMs: number): Promise<{ subscription: Subscription | null; error: string | null }> {
    if (nowMs >= this.nextAt) {
      this.nextAt = nowMs + 5 * 60_000;
      try { this.cached = codexSubscription(await this.read(), nowMs); this.error = null; }
      catch { this.error = 'Не удалось обновить лимиты Codex'; }
    }
    return { subscription: this.cached ? { ...this.cached, ...(this.error ? { stale: true } : {}) } : null, error: this.error };
  }
}
