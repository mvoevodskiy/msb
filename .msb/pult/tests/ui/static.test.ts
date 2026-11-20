// Статические проверки интерфейса: CSP (script-src 'self' — никаких инлайн-скриптов и обработчиков в разметке),
// безопасная вставка (без innerHTML/eval), импорты модулей существуют, договорные классы страниц входа есть в auth.css,
// logic.js без DOM и в синхроне с logic.d.ts, фикстуры предпросмотра отдаются по контракту.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotResponse, FIXTURES } from './preview-server.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI = join(ROOT, 'src', 'ui');
const read = (f: string) => readFileSync(join(UI, f), 'utf8');
const jsFiles = readdirSync(UI).filter((f) => f.endsWith('.js'));
/** Код без комментариев — чтобы слова в комментариях не давали ложных срабатываний. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('index.html и CSP', () => {
  const html = read('index.html');
  test('нет инлайн-скриптов и обработчиков в разметке', () => {
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.match(m[1]!, /\bsrc=/, 'скрипт только из файла');
      assert.equal(m[2]!.trim(), '', 'внутри <script src> пусто');
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'обработчики onclick="…" запрещены CSP');
    assert.doesNotMatch(html, /javascript:/i);
  });
  test('подключает модуль и стили, файлы существуют; внешних ресурсов нет', () => {
    assert.match(html, /<script type="module" src="\/ui\/app\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\/ui\/app\.css">/);
    for (const m of html.matchAll(/(?:src|href)="\/ui\/([^"]+)"/g)) assert.ok(existsSync(join(UI, m[1]!)), `нет файла ${m[1]}`);
    assert.doesNotMatch(html, /https?:\/\//, 'никаких CDN и внешних шрифтов');
  });
  test('доступность каркаса: язык, шапка, навигация, main, подсказка, живой регион', () => {
    assert.match(html, /<html lang="ru">/);
    assert.match(html, /<header class="top">/);
    assert.equal([...html.matchAll(/<nav [^>]*aria-label="Разделы"/g)].length, 2);
    assert.match(html, /<main id="main"/);
    assert.match(html, /role="tooltip"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /<form class="logout" method="post" action="\/logout">/);
  });
});

describe('модули интерфейса', () => {
  test('нет небезопасной вставки и выполнения строк', () => {
    for (const f of jsFiles) {
      const src = code(read(f));
      for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/, /setTimeout\(\s*['"`]/]) {
        assert.doesNotMatch(src, bad, `${f}: ${bad}`);
      }
    }
  });
  test('все относительные импорты существуют', () => {
    for (const f of jsFiles) {
      for (const m of read(f).matchAll(/from\s+'(\.\/[^']+)'/g)) assert.ok(existsSync(join(UI, m[1]!)), `${f}: нет ${m[1]}`);
    }
  });
  test('внешних адресов нет (CSP connect-src и img-src — только self)', () => {
    for (const f of [...jsFiles, 'app.css', 'auth.css']) assert.doesNotMatch(code(read(f)), /https?:\/\/(?!www\.w3\.org\/2000\/svg)/, f);
  });
  test('logic.js чистый: без DOM и окна', () => {
    const src = code(read('logic.js'));
    assert.doesNotMatch(src, /\b(document|window|localStorage|location|navigator)\b/);
  });
  test('logic.d.ts описывает все экспорты logic.js', () => {
    const exported = [...read('logic.js').matchAll(/^export (?:const|function|async function) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]!);
    const dts = read('logic.d.ts');
    const missing = exported.filter((name) => !new RegExp(`export (?:const|function) ${name}\\b`).test(dts));
    assert.deepEqual(missing, []);
    assert.ok(exported.length > 50);
  });
});

describe('стили', () => {
  test('auth.css содержит все договорные классы страниц входа', () => {
    const css = read('auth.css');
    for (const sel of ['body.auth-page', 'main.auth', '.auth-title', '.auth-sub', 'form.auth-form', '.auth-label', '.auth-input', '.auth-error', '.auth-button', '.auth-qr', '.auth-hint', 'code.auth-secret']) {
      assert.ok(css.includes(sel), `нет ${sel}`);
    }
    assert.match(css, /\.auth-qr\s*\{[^}]*background:\s*#fff/i, 'QR на белом поле');
  });
  test('шрифт без внешних загрузок; уважение prefers-reduced-motion', () => {
    for (const f of ['app.css', 'auth.css']) {
      const css = read(f);
      assert.match(css, /"Liberation Sans", "DejaVu Sans", system-ui, sans-serif/);
      assert.doesNotMatch(css, /@import|@font-face|url\(/);
      assert.match(css, /prefers-reduced-motion/);
    }
  });
});

describe('фикстуры предпросмотра', () => {
  test('варианты ответа /api/snapshot', () => {
    assert.ok(FIXTURES.includes('stale') && FIXTURES.includes('empty') && FIXTURES.includes('quiet'));
    const full = snapshotResponse('full')!;
    assert.equal(full.stale, false);
    assert.equal(full.snapshot!.schema, 1);
    assert.equal(full.snapshot!.tasks.length, 7);
    assert.equal(snapshotResponse('stale')!.stale, true);
    assert.equal(snapshotResponse('empty')!.snapshot, null);
    assert.equal(snapshotResponse('quiet')!.snapshot!.tasks.length, 0);
    assert.ok(snapshotResponse('quiet')!.notify.lastError);
    assert.equal(snapshotResponse('offline'), null);
  });
  test('история за три периода — точки по времени, проценты в пределах 0…100', () => {
    for (const r of ['24h', '7d', '30d']) {
      const h = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'ui', `history-${r}.json`), 'utf8'));
      assert.equal(h.range, r);
      assert.ok(h.points.length > 50);
      let prev = 0;
      for (const p of h.points) {
        const t = Date.parse(p.t);
        assert.ok(t > prev, 'по возрастанию времени');
        prev = t;
        for (const k of ['cpu', 'mem', 'disk', 'swap']) assert.ok(p[k] >= 0 && p[k] <= 100, `${r} ${k}=${p[k]}`);
      }
    }
  });
});
