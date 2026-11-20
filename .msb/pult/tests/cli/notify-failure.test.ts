import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureText } from '../../src/cli/notify-failure.ts';

test('текст тревоги: пометка первой строкой, понятное имя, экранирование журнала, ссылка', () => {
  const t = failureText('pult-web.service', ['ok', 'Ошибка: <script>&', ''], 'https://panel.mp.aaa0.ru');
  const lines = t.split('\n');
  assert.equal(lines[0], '🔴 Нужно от тебя: посмотреть — веб-сервис Пульта упал');
  assert.match(t, /&lt;script&gt;&amp;/);
  assert.doesNotMatch(t, /<script>/);
  assert.equal(lines.at(-1), 'https://panel.mp.aaa0.ru');
});

test('текст тревоги без журнала и ссылки; незнакомая служба — по имени', () => {
  const t = failureText('other.service', [], undefined);
  assert.match(t, /^🔴 Нужно от тебя: посмотреть — other\.service упал/);
  assert.doesNotMatch(t, /Последние строки/);
});
