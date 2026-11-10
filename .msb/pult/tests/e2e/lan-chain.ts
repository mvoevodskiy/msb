// Проверка цепочки «nginx Михаила → местный nginx :8792 → веб-сервис» на этом сервере: поднимает ВРЕМЕННЫЙ
// веб-сервис на порту боевого (8791, он должен быть остановлен) с временными данными и паролем, ходит через
// http://<адрес в сети>:8792 так, как ходит nginx Михаила (Host и X-Real-IP), проходит вход паролем и кодом.
// Запуск: node --disable-warning=ExperimentalWarning tests/e2e/lan-chain.ts [адрес:порт]   (по умолчанию 192.168.33.203:8792)

import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { totpAt } from '../../src/server/totp.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const [lanHost, lanPort] = (process.argv[2] ?? '192.168.33.203:8792').split(':');
const DOMAIN = 'pult.dev.mp.aaa0.ru';
const PUBLIC = `https://${DOMAIN}`;
const USER_IP = '203.0.113.7'; // «пользователь» из X-Real-IP

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function call(method: string, path: string, opts: { cookie?: string; form?: Record<string, string> } = {}): Promise<Res> {
  const body = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
  return new Promise((resolve, reject) => {
    const req = request({ host: lanHost, port: Number(lanPort), method, path, headers: {
      Host: DOMAIN, 'X-Real-IP': USER_IP, 'X-Forwarded-For': USER_IP, 'X-Forwarded-Proto': 'https',
      ...(method === 'POST' ? { Origin: PUBLIC, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(body ?? '')) } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    } }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const cookieOf = (r: Res): string => ([] as string[]).concat(r.headers['set-cookie'] ?? []).map(c => c.split(';')[0]).join('; ');
function expect(cond: boolean, what: string, r?: Res): void {
  if (!cond) throw new Error(`${what}${r ? ` (HTTP ${r.status}: ${r.body.slice(0, 200)})` : ''}`);
  console.log(`✓ ${what}`);
}

async function main(): Promise<void> {
  const down = await call('GET', '/');
  expect(down.status === 502 && down.body.includes('Пульт сейчас не отвечает'), 'веб-сервис остановлен — nginx отдаёт страницу «Пульт сейчас не отвечает»', down);

  const data = mkdtempSync(join(tmpdir(), 'pult-lan-'));
  const password = randomBytes(12).toString('base64url');
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src/server/main.ts')], {
    env: { ...process.env, PULT_DATA_DIR: data, PULT_PASSWORD: password, PULT_INGEST_TOKEN: randomBytes(32).toString('base64url'),
      PULT_PORT: '8791', PULT_HOST: '127.0.0.1', PULT_PUBLIC_URL: PUBLIC, PULT_COOKIE_SECURE: '1', PULT_TRUST_PROXY: '1', PULT_TG_TOKEN: '', PULT_TG_CHAT_ID: '', OWNER_USER_ID: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => (log += d)); server.stderr.on('data', d => (log += d));
  try {
    for (let i = 0; ; i++) {
      const r = await call('GET', '/health').catch(() => null);
      if (r?.status === 200) break;
      if (i > 50) throw new Error(`временный веб-сервис не поднялся:\n${log}`);
      await new Promise(r => setTimeout(r, 200));
    }
    const root = await call('GET', '/');
    expect(root.status === 200 && root.body.includes('auth-form'), 'без входа — форма входа на «/» (без редиректа, для Mini App)', root);
    const form = await call('GET', '/login');
    expect(form.status === 200 && form.body.includes('auth-form'), 'страница входа открывается через nginx', form);
    const bad = await call('POST', '/login', { form: { password: 'неверный' } });
    expect(bad.status === 401 && bad.body.includes('Неверный пароль'), 'неверный пароль — отказ (401 и форма с ошибкой)', bad);
    const ok = await call('POST', '/login', { form: { password } });
    expect(ok.status === 302 && ok.headers.location === '/enroll', 'верный пароль — к подключению второго фактора (Origin внешнего адреса принят)', ok);
    const pre = cookieOf(ok);
    expect(/Secure/.test(String(ok.headers['set-cookie'])), 'cookie с флагом Secure');
    const enroll = await call('GET', '/enroll', { cookie: pre });
    const secret = /<code class="auth-secret">([^<]+)</.exec(enroll.body)?.[1]?.replace(/\s+/g, '');
    expect(enroll.status === 200 && !!secret, 'QR и секрет для приложения показаны', enroll);
    const done = await call('POST', '/enroll', { cookie: pre, form: { code: totpAt(secret!, Date.now()) } });
    expect(done.status === 302 && done.headers.location === '/', 'код из приложения принят — вход выполнен', done);
    const api = await call('GET', '/api/snapshot', { cookie: cookieOf(done) });
    expect(api.status === 200, 'API отвечает после входа', api);
    expect(log.includes(USER_IP), `в журнале веб-сервиса IP пользователя из X-Real-IP (${USER_IP}), а не адрес nginx`);
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => server.on('close', r));
    rmSync(data, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(`✗ ${(e as Error).message}`); process.exitCode = 1; });
