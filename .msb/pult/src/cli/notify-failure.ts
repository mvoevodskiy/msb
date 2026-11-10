#!/usr/bin/env node
// Тревога «служба Пульта упала и не поднимается» — вызывает systemd через OnFailure=
// (deploy/pult-notify-failure@.service). Работает отдельно от веб-сервиса: он сам может быть упавшей службой.
// Нет токена бота — тихо выходит (тревогу «сборщик молчит» тогда пришлёт веб-сервис).

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { escHtml, sendTg, tgFromEnv } from '../shared/tg.ts';

const NAMES: Record<string, string> = {
  'pult-web.service': 'веб-сервис Пульта',
  'pult-collector.service': 'сборщик Пульта',
};

export function failureText(unit: string, lastLines: string[], publicUrl: string | undefined): string {
  const esc = escHtml;
  const name = NAMES[unit] ?? unit;
  const tail = lastLines.filter(Boolean).slice(-5).map(l => esc(l.slice(0, 200)));
  return [
    `🔴 Нужно от тебя: посмотреть — ${esc(name)} упал`,
    '',
    `<b>Пульт</b>: служба ${esc(unit)} падала несколько раз подряд, systemd перестал её перезапускать.`,
    'Поручи личному боту разобраться: он видит журнал службы.',
    ...(tail.length ? ['', 'Последние строки журнала:', `<pre>${tail.join('\n')}</pre>`] : []),
    ...(publicUrl ? ['', publicUrl] : []),
  ].join('\n');
}

function journalTail(unit: string): string[] {
  try {
    return execFileSync('journalctl', ['-u', unit, '-n', '5', '--no-pager', '-o', 'cat'], { encoding: 'utf8', timeout: 5000 }).split('\n');
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const unit = process.argv[2];
  if (!unit) { process.stderr.write('Использование: notify-failure.ts <служба>\n'); process.exitCode = 2; return; }
  const tg = tgFromEnv(process.env);
  if (!tg) { process.stdout.write('Бот уведомлений не задан — тревогу не отправляю.\n'); return; }
  const err = await sendTg(tg, failureText(unit, journalTail(unit), process.env.PULT_PUBLIC_URL));
  if (err === null) process.stdout.write(`Тревога об отказе ${unit} отправлена.\n`);
  else { process.stderr.write(`Тревога не отправлена: ${err}\n`); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
