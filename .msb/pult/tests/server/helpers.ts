// Общие помощники тестов веб-сервиса: временный каталог данных, настройки, снимок-пример,
// подменный Telegram (fetch) и простой HTTP-клиент на node:http (полный контроль над Origin/Cookie).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Snapshot } from '../../src/shared/types.ts';
import { loadConfig, type Config } from '../../src/server/config.ts';

export const PASSWORD = 'correct horse battery';
export const INGEST_TOKEN = 'i'.repeat(16) + 'ngest-token-0123456789';
export const TG_TOKEN = '123456:' + 'A'.repeat(35);

export function tmpDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'pult-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function env(dataDir: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PULT_DATA_DIR: dataDir,
    PULT_PASSWORD: PASSWORD,
    PULT_INGEST_TOKEN: INGEST_TOKEN,
    PULT_PUBLIC_URL: 'https://panel.example.test',
    PULT_COOKIE_SECURE: '0',
    PULT_PORT: '0',
    PULT_TG_TOKEN: TG_TOKEN,
    PULT_TG_CHAT_ID: '42',
    ...extra,
  };
}

export function config(dataDir: string, extra: Record<string, string | undefined> = {}): Config {
  return loadConfig(env(dataDir, extra));
}

export function fixture(): Snapshot {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'server', 'snapshot.json'), 'utf8')) as Snapshot;
}

export interface TgCall { method: string; body: Record<string, unknown> }

/** Подменный Telegram: копит вызовы; reply задаёт ответ (по умолчанию — успех). */
export function fakeTelegram(reply: (call: TgCall) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true, result: { username: 'pult_test_bot' } } })) {
  const calls: TgCall[] = [];
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const method = url.split('/').pop() ?? '';
    const call = { method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
    calls.push(call);
    const r = reply(call);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const texts = (): string[] => calls.filter(c => c.method === 'sendMessage').map(c => String(c.body.text));
  return { fetchFn, calls, urls, texts };
}

export interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

export function http(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: o.headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** Значение cookie из Set-Cookie ответа. */
export function cookieFrom(res: Res, name: string): string | null {
  const set = res.headers['set-cookie'];
  const list = Array.isArray(set) ? set : set ? [set] : [];
  for (const c of list) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return m[1];
  }
  return null;
}

export const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
