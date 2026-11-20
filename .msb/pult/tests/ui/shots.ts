// Снимки экрана интерфейса для проверки глазами: все экраны на 1440 и 390 px, узкий телефон 360 px,
// состояния (устарело, нет связи, пусто, тихо, 500, вход), подсказки при наведении.
// Playwright берётся из проекта zapcita (в зависимости Пульта его НЕ добавляем).
// Запуск: node tests/ui/shots.ts [фильтр-подстрока]   → tests/tmp/ui-shots/*.png
// Выход с кодом 1, если в консоли браузера были ошибки (кроме ожидаемых «Failed to load resource» в сбойных фикстурах)
// или страница получила горизонтальную прокрутку.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreview } from './preview-server.ts';

const require = createRequire(import.meta.url);
const PLAYWRIGHT = '/home/client/projects/zapcita/site/node_modules/playwright';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'ui-shots');

interface Shot {
  name: string; fx: string; hash: string; width: number; height?: number;
  /** Действие перед снимком (наведение, обрыв связи). */
  act?: (page: any, ctx: { url: string; context: any }) => Promise<void>;
  /** Ждать ли отрисовки графика. */
  chart?: string;
  /** Снимать только видимую часть (для подсказок). */
  viewport?: boolean;
  /** Страница не панели (вход) — не ждать заголовок. */
  raw?: boolean;
  /** Сенсорный экран (касания вместо мыши). */
  touch?: boolean;
}

const filter = process.argv[2] ?? '';
const D = 1440, M = 390, S = 360;

async function hoverAt(page: any, sel: string, fx: number, fy = 0.5) {
  const el = page.locator(sel).first();
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  if (!b) throw new Error(`нет элемента ${sel}`);
  await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy);
  await page.waitForTimeout(150);
}

async function goOffline(page: any, { url, context }: { url: string; context: any }) {
  await context.addCookies([{ name: 'fx', value: 'offline', url }]);
  await page.waitForTimeout(5200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForSelector('.banner.b-crit');
  await page.waitForTimeout(200);
}

const shots: Shot[] = [];
for (const [w, p] of [[D, 'd'], [M, 'm']] as const) {
  shots.push(
    { name: `${p}-1-obzor`, fx: 'full', hash: '#/', width: w, chart: '.spark-host svg' },
    { name: `${p}-2-zadachi`, fx: 'full', hash: '#/tasks', width: w },
    { name: `${p}-3-kartochka`, fx: 'full', hash: '#/tasks/socpub-dev', width: w, chart: '.bars-host svg' },
    { name: `${p}-4-boty`, fx: 'full', hash: '#/bots', width: w, chart: '.lanes-host svg' },
    { name: `${p}-5-proekty`, fx: 'full', hash: '#/projects', width: w },
    { name: `${p}-6-server`, fx: 'full', hash: '#/server', width: w, chart: '.line-host svg' },
    { name: `${p}-st-stale`, fx: 'stale', hash: '#/', width: w, chart: '.spark-host svg' },
    { name: `${p}-st-offline`, fx: 'full', hash: '#/', width: w, chart: '.spark-host svg', act: goOffline },
    { name: `${p}-st-empty`, fx: 'empty', hash: '#/', width: w },
    { name: `${p}-st-quiet`, fx: 'quiet', hash: '#/', width: w },
    { name: `${p}-st-login`, fx: 'unauth', hash: '#/', width: w, raw: true },
  );
}
shots.push(
  { name: 'd-2-zadachi-7d', fx: 'full', hash: '#/tasks?range=7d', width: D },
  { name: 'd-2-zadachi-smm', fx: 'full', hash: '#/tasks?bot=SMM', width: D },
  { name: 'd-3-kartochka-30d', fx: 'full', hash: '#/tasks/socpub-dev?range=30d', width: D, chart: '.bars-host svg' },
  { name: 'd-3-kartochka-timer', fx: 'full', hash: '#/tasks/infosec-x?range=7d', width: D, chart: '.bars-host svg' },
  { name: 'd-3-kartochka-event', fx: 'full', hash: '#/tasks/socpub-alarm?range=7d', width: D, chart: '.bars-host svg' },
  { name: 'd-3-kartochka-once', fx: 'full', hash: '#/tasks/offer-reminder', width: D },
  { name: 'd-3-kartochka-net', fx: 'full', hash: '#/tasks/net-takoy', width: D },
  { name: 'd-6-server-30d', fx: 'full', hash: '#/server?range=30d', width: D, chart: '.line-host svg' },
  { name: 'd-6-server-nohist', fx: 'nohist', hash: '#/server', width: D },
  { name: 'd-st-quiet-tasks', fx: 'quiet', hash: '#/tasks', width: D },
  { name: 'd-st-error500', fx: 'error500', hash: '#/', width: D },
  { name: 'd-st-enroll', fx: 'full', hash: '', width: D, raw: true },
  { name: 'd-1920-obzor', fx: 'full', hash: '#/', width: 1920, chart: '.spark-host svg' },
  { name: 'd-1000-zadachi', fx: 'full', hash: '#/tasks', width: 1000 },
  { name: 't-800-obzor', fx: 'full', hash: '#/', width: 800, chart: '.spark-host svg' },
  { name: 's-1-obzor', fx: 'full', hash: '#/', width: S, chart: '.spark-host svg' },
  { name: 's-2-zadachi', fx: 'full', hash: '#/tasks', width: S },
  { name: 's-3-kartochka', fx: 'full', hash: '#/tasks/socpub-dev', width: S, chart: '.bars-host svg' },
  { name: 's-4-boty', fx: 'full', hash: '#/bots', width: S, chart: '.lanes-host svg' },
  { name: 's-6-server', fx: 'full', hash: '#/server', width: S, chart: '.line-host svg' },
  // Телефон «как в руке» — видимая часть с нижней навигацией.
  { name: 'm-vp-obzor', fx: 'full', hash: '#/', width: M, chart: '.spark-host svg', viewport: true },
  { name: 'm-vp-zadachi', fx: 'full', hash: '#/tasks', width: M, viewport: true },
  { name: 's-vp-kartochka', fx: 'full', hash: '#/tasks/socpub-dev', width: S, chart: '.bars-host svg', viewport: true },
  // Подсказки при наведении — видимая часть окна.
  { name: 'h-server-cpu', fx: 'full', hash: '#/server', width: D, chart: '.line-host svg', viewport: true, act: (pg) => hoverAt(pg, '.line-host svg', 0.62, 0.5) },
  { name: 'h-task-bars', fx: 'full', hash: '#/tasks/socpub-dev?range=7d', width: D, chart: '.bars-host svg', viewport: true, act: (pg) => hoverAt(pg, '.bars-host svg', 0.97, 0.7) },
  { name: 'h-task-gap', fx: 'full', hash: '#/tasks/socpub-dev?range=7d', width: D, chart: '.bars-host svg', viewport: true, act: (pg) => hoverAt(pg, '.bars-host svg', 0.75, 0.5) },
  { name: 'h-bots-lanes', fx: 'full', hash: '#/bots', width: D, chart: '.lanes-host svg', viewport: true, act: (pg) => hoverAt(pg, '.lanes-host svg', 0.5, 0.21) },
  { name: 'h-obzor-strip', fx: 'full', hash: '#/', width: D, chart: '.strip-host svg', viewport: true, act: (pg) => hoverAt(pg, '.strip-host svg', 0.99, 0.5) },
  // Клавиатура: фокус на графике и стрелка влево.
  // Касание на телефоне: подсказка по столбику хода.
  { name: 'm-tap-bars', fx: 'full', hash: '#/tasks/socpub-dev', width: M, chart: '.bars-host svg', viewport: true, touch: true, act: async (pg) => {
    const el = pg.locator('.bars-host svg').first(); await el.scrollIntoViewIfNeeded(); const b = await el.boundingBox();
    await pg.touchscreen.tap(b.x + b.width * 0.985, b.y + b.height * 0.6); await pg.waitForTimeout(150);
  } },
  { name: 'k-server-keys', fx: 'full', hash: '#/server', width: D, chart: '.line-host svg', viewport: true, act: async (pg) => {
    await pg.locator('.line-host svg').first().focus(); await pg.keyboard.press('ArrowLeft'); await pg.keyboard.press('ArrowLeft'); await pg.waitForTimeout(100);
  } },
  { name: 'k-tabs-focus', fx: 'full', hash: '#/', width: D, viewport: true, act: async (pg) => {
    await pg.keyboard.press('Tab'); await pg.keyboard.press('Tab'); await pg.keyboard.press('Tab'); await pg.waitForTimeout(100);
  } },
);

async function main() {
  const { chromium } = require(PLAYWRIGHT);
  mkdirSync(OUT, { recursive: true });
  const preview = await startPreview(0);
  const browser = await chromium.launch();
  const problems: string[] = [];
  try {
    for (const sh of shots.filter((x) => x.name.includes(filter))) {
      const context = await browser.newContext({ viewport: { width: sh.width, height: sh.height ?? (sh.width < 500 ? 844 : 900) }, deviceScaleFactor: sh.width < 500 ? 2 : 1, locale: 'ru-RU', timezoneId: 'Europe/Moscow', hasTouch: !!sh.touch, isMobile: !!sh.touch });
      const page = await context.newPage();
      const errors: string[] = [];
      const lenient = ['offline', 'unauth', 'error500', 'nohist'].includes(sh.fx) || sh.act === goOffline;
      page.on('console', (m: any) => { if (m.type() === 'error' && !(lenient && /Failed to load resource/.test(m.text()))) errors.push(m.text()); });
      page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`));
      const target = sh.name === 'd-st-enroll' ? `${preview.url}/enroll` : `${preview.url}/?fx=${sh.fx}${sh.hash}`;
      await page.goto(target, { waitUntil: 'networkidle' });
      if (!sh.raw) {
        await page.waitForFunction(() => !document.querySelector('.loading') && document.querySelector('[data-focus="title"]'));
        if (sh.chart) await page.waitForSelector(sh.chart);
        await page.waitForTimeout(250);
      } else {
        await page.waitForTimeout(200);
      }
      if (sh.act) await sh.act(page, { url: preview.url, context });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) problems.push(`${sh.name}: горизонтальная прокрутка на ${overflow} px`);
      const file = join(OUT, `${sh.name}.png`);
      await page.screenshot({ path: file, fullPage: !sh.viewport });
      for (const e of errors) problems.push(`${sh.name}: ${e}`);
      console.log(`${errors.length ? '✗' : '✓'} ${sh.name}`);
      await context.close();
    }
  } finally {
    await browser.close();
    await preview.close();
  }
  if (problems.length) {
    console.error('\nПроблемы:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exitCode = 1;
  } else console.log(`\nГотово: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
