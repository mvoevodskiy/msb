import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autonomyHomeScreen,
  extrasScreen,
  hubScreen,
  monitorScreen,
  pultScreen,
  settingsScreen,
} from '../src/telegram/screens.mjs';
import { BOT_COMMANDS } from '../src/telegram/commands.mjs';

test('hub copy', () => {
  const h = hubScreen();
  assert.match(h.text, /Готов\. Пиши задачу/);
});

test('settings buttons', () => {
  const s = settingsScreen({ dailySpendLimit: 10 });
  const data = s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('settings:auth'));
  assert.ok(data.includes('settings:bots'));
  assert.ok(data.includes('settings:extras'));
  assert.ok(data.includes('settings:limit'));
});

test('extras + monitor + autonomy callbacks', async () => {
  const e = extrasScreen();
  const extras = e.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(extras.includes('settings:ssh'));
  assert.ok(extras.includes('settings:updates'));
  assert.ok(extras.includes('settings:pult'));
  const pOff = pultScreen({ installed: true, enabled: false, active: false }, { password: '', host: '127.0.0.1' });
  const pOffBtns = pOff.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(pOffBtns.includes('settings:pult:on'));
  assert.ok(pOffBtns.includes('settings:pult:password'));
  assert.ok(pOffBtns.includes('settings:pult:listen'));
  assert.ok(pOffBtns.includes('settings:pult:tg-token'));
  const pOn = pultScreen({ installed: true, enabled: true, active: true }, { password: 'x', host: '0.0.0.0' });
  assert.ok(pOn.keyboard.inline_keyboard.flat().some((b) => b.callback_data === 'settings:pult:off'));
  assert.match(pOn.text, /все интерфейсы/);
  const m = await monitorScreen();
  assert.ok(m.keyboard.inline_keyboard.flat().some((b) => b.callback_data === 'mon:sources'));
  const a = await autonomyHomeScreen();
  assert.ok(a.keyboard.inline_keyboard.flat().some((b) => b.callback_data === 'auto:tasks'));
});

test('slash commands include core set', () => {
  const names = BOT_COMMANDS.map((c) => c.command);
  for (const c of ['start', 'help', 'settings', 'pult', 'monitor', 'newtask', 'stop', 'claude']) {
    assert.ok(names.includes(c), c);
  }
});
