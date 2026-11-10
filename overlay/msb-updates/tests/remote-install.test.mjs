import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRemoteExtInstallScript } from '../src/ssh/remote.mjs';

test('install script ставит шаблонный drop-in и рестартит всех ботов', () => {
  const script = buildRemoteExtInstallScript({
    apiBase: 'https://updates.example',
    installToken: 'tok',
    manifestJson: { version: 'test', channel: 'ext', files: [] },
    filesBase64: [],
  });

  assert.match(script, /msb-bot@\.service\.d\/60-ext-entry\.conf/);
  assert.match(script, /bot-ctl\.sh restart all/);
  assert.match(script, /LIVE\/bots/);
  assert.match(script, /RESTARTED/);
  assert.match(script, /DROPIN_OK/);
  // не только default
  assert.doesNotMatch(script, /bot-ctl\.sh restart \|\| true\n\s+else\n\s+sudo -n systemctl restart msb-bot@default/);
});
