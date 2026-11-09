/**
 * История фоновых задач; локальные [напоминания](./reminder-runs.mjs) читаются рядом с интервалами.
 * Навигация: [Автономка](./README.md) → [Telegram](../telegram/README.md).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { autonomyDir } from '../paths.mjs';
import { parseReminderRun, reminderRunPath } from './reminder-runs.mjs';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MESSAGE_LIMIT = 3500;
const MENU_HEADER = '🕓 <b>История</b>\n\n';
const MENU_EMPTY = `${MENU_HEADER}Прогонов в журнале пока нет. Это не поломка: если задачи стоят, но их час ещё не наступал, записывать нечего.\n⠀`;

/** The previous command accepts 1–50 entries, defaulting to 10. */
export function historyLimit(value) {
  const n = parseInt(String(value ?? '').trim() || '10', 10) || 10;
  return Math.min(50, Math.max(1, n));
}

function parseIntervalRun(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at)) ||
      typeof entry.taskId !== 'string' || typeof entry.ok !== 'boolean') return null;
  return entry;
}

async function readRunFile(file, count, parse) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { runs: [], malformed: 0 };
    throw error;
  }
  const runs = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = parse(JSON.parse(line));
      if (entry === undefined) continue;
      if (entry === null) { malformed++; continue; }
      runs.push(entry);
      if (runs.length > count) runs.shift();
    } catch {
      malformed++;
    }
  }
  return { runs: runs.reverse(), malformed };
}

/** Preserve the interval journal and include successful/failed direct reminders. */
export async function readRecentRuns({ limit = 10, env = process.env } = {}) {
  const physicalPath = file => fs.realpath(file).catch(() => file);
  const [intervalFile, reminderFile] = await Promise.all([
    physicalPath(path.resolve(autonomyDir(env), 'runs.jsonl')),
    physicalPath(reminderRunPath(env)),
  ]);
  const count = historyLimit(limit);
  if (intervalFile === reminderFile) {
    return readRunFile(intervalFile, count, row => row?.kind === 'reminder' ? parseReminderRun(row) : parseIntervalRun(row));
  }
  const [interval, reminders] = await Promise.all([
    readRunFile(intervalFile, count, parseIntervalRun),
    readRunFile(reminderFile, count, parseReminderRun).catch(() => ({ runs: [], malformed: 1 })),
  ]);
  const runs = reminders.runs.length
    ? [...interval.runs, ...reminders.runs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, count)
    : interval.runs;
  return { runs, malformed: interval.malformed + reminders.malformed };
}

function dateLabel(value) {
  const date = new Date(value);
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${hour}:${minute}`;
}

function runText(entry) {
  const label = typeof entry.name === 'string' && entry.name ? entry.name : 'задача ' + entry.taskId;
  const lines = [`${entry.ok ? '🟢' : '🔴'} ${dateLabel(entry.at)} · ${label}`];
  if (entry.ok) lines.push('   ✅ готово');
  else lines.push(`   ошибка${typeof entry.error === 'string' && entry.error ? `: ${entry.error}` : ''}`);
  if (typeof entry.preview === 'string' && entry.preview) lines.push(`   ${entry.preview}`);
  return lines.join('\n');
}

// Escape one Unicode code point at a time so no Telegram entity or emoji can be
// split across messages. Raw length stays below Telegram's 4096-character limit.
function htmlPages(text, header = '') {
  const pages = [];
  let page = header;
  for (const character of text) {
    const safe = character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : character;
    if (page.length + safe.length > MESSAGE_LIMIT) {
      pages.push(page);
      page = '';
    }
    page += safe;
  }
  if (page || !pages.length) pages.push(page);
  return pages;
}

/** Telegram-safe pages; menu and command share the same recorded data. */
export async function historyPages({ limit = 10, env = process.env, menu = false } = {}) {
  let history;
  try {
    history = await readRecentRuns({ limit, env });
  } catch {
    return htmlPages('✖ Не удалось прочитать журнал фоновых прогонов.', menu ? MENU_HEADER : '');
  }
  const { runs, malformed } = history;
  if (!runs.length && !malformed) return [menu ? MENU_EMPTY : '📊 Автономка ещё не запускалась.'];
  if (!runs.length) return htmlPages('⚠️ В журнале нет читаемых записей.', menu ? MENU_HEADER : '');

  const ok = runs.filter((entry) => entry.ok).length;
  const lines = [
    `📊 Автономка — последние ${runs.length} прогонов`,
    `🟢 ok ${ok} · 🔴 ошибка ${runs.length - ok}`,
    ...runs.map((entry) => runText(entry)),
  ];
  if (malformed) lines.push(`⚠️ Пропущено повреждённых или неподдерживаемых записей: ${malformed}.`);
  return htmlPages(lines.join('\n\n'), menu ? MENU_HEADER : '');
}
