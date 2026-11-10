// Сквозная проверка на живых данных этого сервера: настоящий веб-сервис на временном порту и с временным
// каталогом → живой снимок сборщика (+ история нагрузки за сутки из sysstat, если есть) → вход в браузере
// паролем и кодом TOTP (подключение второго фактора) → снимки всех экранов на 1440 и 390 px.
// Ничего не меняет на сервере, Telegram не трогает. Playwright — из проекта zapcita (в зависимости не входит).
// Запуск: node --disable-warning=ExperimentalWarning tests/e2e/live.ts  → tests/tmp/e2e/*.png; код 1 при ошибке.

import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { totpAt } from '../../src/server/totp.ts';
import type { Snapshot } from '../../src/shared/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'tests/tmp/e2e');
const require = createRequire(import.meta.url);
const { chromium } = require('/home/client/projects/zapcita/site/node_modules/playwright');

const freePort = () => new Promise<number>(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

/** Сутки нагрузки из sysstat: [время, cpu%, mem%] — чтобы графики на снимках были настоящими. */
function sarHistory(): { t: number; cpu: number; mem: number }[] {
  const out: { t: number; cpu: number; mem: number }[] = [];
  const now = Date.now();
  for (const back of [1, 0]) {
    const d = new Date(now - back * 86_400_000);
    const file = `/var/log/sysstat/sa${String(d.getUTCDate()).padStart(2, '0')}`;
    if (!existsSync(file)) continue;
    const day = d.toISOString().slice(0, 10);
    const run = (flag: string) => { try { return execFileSync('sar', [flag, '-f', file], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }); } catch { return ''; } };
    const cpu = new Map<string, number>(); const mem = new Map<string, number>();
    for (const l of run('-u').split('\n')) { const f = l.trim().split(/\s+/); if (f[1] === 'all' && /^\d\d:\d\d/.test(f[0]!)) cpu.set(f[0]!, 100 - Number(f[7])); }
    for (const l of run('-r').split('\n')) { const f = l.trim().split(/\s+/); if (/^\d\d:\d\d/.test(f[0] ?? '') && /^\d+$/.test(f[1] ?? '')) mem.set(f[0]!, Number(f[4])); }
    for (const [hm, c] of cpu) {
      const t = Date.parse(`${day}T${hm}Z`);
      if (now - t < 86_400_000 && now - t > 120_000 && mem.has(hm)) out.push({ t, cpu: c, mem: mem.get(hm)! });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// Сервис не принимает один и тот же шаг TOTP дважды — перед каждым вводом кода ждём новый шаг.
let usedStep = -1;
async function freshStep(): Promise<void> {
  const step = () => Math.floor(Date.now() / 30_000);
  while (step() <= usedStep) await new Promise(r => setTimeout(r, 500));
  usedStep = step();
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const data = mkdtempSync(join(tmpdir(), 'pult-e2e-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(12).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  const env = { ...process.env, PULT_DATA_DIR: data, PULT_PASSWORD: password, PULT_INGEST_TOKEN: token, PULT_PORT: String(port),
    PULT_HOST: '127.0.0.1', PULT_PUBLIC_URL: base, PULT_COOKIE_SECURE: '0', PULT_TG_TOKEN: '', PULT_TG_CHAT_ID: '' };
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src/server/main.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', d => (serverLog += d)); server.stderr.on('data', d => (serverLog += d));
  const errors: string[] = [];
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* ещё стартует */ }
      if (i > 50) throw new Error(`веб-сервис не поднялся:\n${serverLog}`);
      await new Promise(r => setTimeout(r, 200));
    }
    const snap = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src/collector/main.ts'), 'once'], { encoding: 'utf8', maxBuffer: 20e6 })) as Snapshot;
    const post = async (s: Snapshot) => {
      const r = await fetch(`${base}/api/ingest`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
      if (r.status !== 204) throw new Error(`ingest: HTTP ${r.status} ${await r.text()}`);
    };
    const hist = sarHistory();
    for (const p of hist) {
      const memUsedMb = Math.round(snap.server.memTotalMb * p.mem / 100);
      await post({ ...snap, collectedAt: new Date(p.t).toISOString(), server: { ...snap.server, cpuPct: p.cpu, memUsedMb } });
    }
    await post(snap);
    console.log(`снимок отправлен (+ ${hist.length} точек истории из sysstat)`);

    const browser = await chromium.launch();
    for (const [label, width, height] of [['d', 1440, 1000], ['m', 390, 844]] as const) {
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1.5 });
      const page = await ctx.newPage();
      page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
      page.on('pageerror', (e: Error) => errors.push(`${label}: ${e.message}`));
      await page.goto(`${base}/`);
      if (!page.url().includes('/login')) throw new Error('без входа панель открылась — так быть не должно');
      await page.fill('input[name=password]', password);
      const codeField = await page.$('input[name=code]');
      if (codeField) { await freshStep(); await codeField.fill(totpAt(String(process.env.PULT_E2E_SECRET), Date.now())); }
      await page.click('button[type=submit]');
      if (page.url().includes('/enroll')) {
        if (label === 'd') await page.screenshot({ path: join(OUT, `${label}-0-enroll.png`), fullPage: true });
        const secret = (await page.textContent('code.auth-secret'))!.replace(/\s+/g, '');
        process.env.PULT_E2E_SECRET = secret;
        await freshStep();
        await page.fill('input[name=code]', totpAt(secret, Date.now()));
        await page.click('button[type=submit]');
      }
      await page.waitForURL(`${base}/`);
      for (const [name, hash] of [['1-obzor', '#/'], ['2-zadachi', '#/tasks'], ['4-boty', '#/bots'], ['5-proekty', '#/projects'], ['6-server', '#/server']] as const) {
        await page.goto(`${base}/${hash}`);
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(OUT, `${label}-${name}.png`), fullPage: true });
      }
      const firstTask = snap.tasks.find(t => t.runs.length > 1) ?? snap.tasks[0];
      if (firstTask) {
        await page.goto(`${base}/#/tasks/${firstTask.id}`);
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(OUT, `${label}-3-kartochka.png`), fullPage: true });
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (overflow) errors.push(`${label}: горизонтальная прокрутка`);
      await ctx.close();
    }
    // второй вход: 2FA уже подключена — пароль + код
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/login`);
    await page.fill('input[name=password]', password);
    await freshStep();
    await page.fill('input[name=code]', totpAt(process.env.PULT_E2E_SECRET!, Date.now()));
    await page.click('button[type=submit]');
    await page.waitForURL(`${base}/`);
    console.log('второй вход паролем и кодом — успешно');
    await ctx.close();
    await browser.close();
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => server.on('close', r));
    rmSync(data, { recursive: true, force: true });
  }
  if (errors.length) { console.error('ОШИБКИ:\n' + errors.join('\n')); process.exitCode = 1; }
  else console.log(`готово: ${OUT}`);
}

await main();
