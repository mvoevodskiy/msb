/** Settings routing wizard through Telegram callbacks; private HOME, no CLI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { defaultRoutingDraft, loadProjectRouting, saveProjectRouting } from '../src/projects/routing.mjs';
import { ROUTING_MODES } from '../src/projects/routing-modes.mjs';

const buttons = f => f.editOptions.at(-1)?.reply_markup?.inline_keyboard.flat() || [];

test('routing menu: settings wizard writes settings.yaml for workspace', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  await f.callback('menu:settings');
  assert.ok(buttons(f).some(b => b.callback_data === 'settings:routing'));
  await f.callback('settings:routing');
  assert.match(f.edits.at(-1), /Маршрутизация задач/);
  assert.ok(buttons(f).some(b => b.callback_data === 'settings:routing:wiz'));

  await f.callback('settings:routing:wiz');
  assert.match(f.edits.at(-1), /шаг 1\/3/);
  await f.callback('settings:routing:wiz:default:ask');
  assert.match(f.edits.at(-1), /шаг 2\/3/);
  await f.callback('settings:routing:wiz:apply:sticky');

  for (const mode of ROUTING_MODES) {
    await f.callback(`settings:routing:wiz:prov:${mode}:claude`);
    await f.callback(`settings:routing:wiz:model:${mode}:${mode === 'ask' ? 'sonnet' : mode === 'run' ? 'skip' : 'opus'}`);
  }

  assert.match(f.edits.at(-1), /подтверждение/);
  await f.callback('settings:routing:wiz:save');
  assert.match(f.edits.at(-1), /settings\.yaml/);

  const loaded = await loadProjectRouting(f.workspace);
  assert.equal(loaded.settings.routing.default, 'ask');
  assert.equal(loaded.settings.routing.types.make.provider, 'claude');
  assert.equal(loaded.settings.routing.types.make.model, 'opus');
  assert.equal(loaded.settings.routing.types.run.model, null);
  await fs.access(path.join(f.workspace, '.msb', 'settings.yaml'));
});

test('routing menu: disable keeps file with enabled false; enable restores', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  await saveProjectRouting(f.workspace, defaultRoutingDraft(['claude']));
  assert.equal((await loadProjectRouting(f.workspace)).settings.routing.enabled, true);

  await f.callback('settings:routing');
  assert.ok(buttons(f).some(b => b.callback_data === 'settings:routing:disable'));
  await f.callback('settings:routing:disable');
  await f.callback('settings:routing:disable:yes');
  assert.match(f.edits.at(-1), /enabled: false|выключена/i);
  const off = await loadProjectRouting(f.workspace);
  assert.ok(off);
  assert.equal(off.settings.routing.enabled, false);
  assert.ok(buttons(f).some(b => b.callback_data === 'settings:routing:enable'));

  await f.callback('settings:routing:enable');
  assert.equal((await loadProjectRouting(f.workspace)).settings.routing.enabled, true);
});

test('routing menu: delete removes the settings file', async t => {
  const f = await fixture(t, undefined, { overlay: false });
  await saveProjectRouting(f.workspace, defaultRoutingDraft(['claude']));
  await f.callback('settings:routing');
  await f.callback('settings:routing:delete');
  await f.callback('settings:routing:delete:yes');
  assert.equal(await loadProjectRouting(f.workspace), null);
});
