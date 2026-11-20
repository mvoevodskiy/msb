import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { listTgAuthCandidates } from '../../src/server/tg-bots.ts';
import { verifyTgWebAppInitData } from '../../src/server/tg-webapp.ts';

const MSB_TOKEN = '999001:' + 'M'.repeat(35);
const JAR1_TOKEN = '999002:' + 'J'.repeat(35);
const OWNER = '42';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'pult-bots-profile-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [namespace, token] of [['.msb', MSB_TOKEN], ['.iia', JAR1_TOKEN]]) {
    const folder = join(home, namespace, 'bots/default');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, '.env'), `BOT_TOKEN="${token}"\nADMIN_ID=${OWNER}\n`);
  }
  return { home, jar1: join(home, '.iia/bots'), msb: join(home, '.msb/bots') };
}

test('Mini App discovery keeps the default MSB bots directory', t => {
  const { home } = fixture(t);
  const candidates = listTgAuthCandidates(null, home, {});
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].token, MSB_TOKEN);
  assert.equal(candidates[0].chatId, OWNER);
});

test('Mini App discovery honors explicit directory and its ROOT alias without reading the other profile', t => {
  const { home, jar1, msb } = fixture(t);
  for (const env of [{ PULT_BOTS_DIR: jar1, PULT_BOTS_ROOT: msb }, { PULT_BOTS_ROOT: jar1 }]) {
    const candidates = listTgAuthCandidates(null, home, env);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].token, JAR1_TOKEN);
    assert.equal(candidates[0].chatId, OWNER);
  }
});

test('JAR1 discovery authenticates the owner Mini App without a notification bot and still rejects another owner', t => {
  const { home, jar1 } = fixture(t);
  const [candidate] = listTgAuthCandidates(null, home, { PULT_BOTS_DIR: jar1 });
  const now = 1_700_000_000;
  const sign = (id: number) => {
    const fields = new URLSearchParams({ auth_date: String(now), user: JSON.stringify({ id }) });
    const checked = [...fields].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${key}=${value}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(JAR1_TOKEN).digest();
    fields.set('hash', createHmac('sha256', secret).update(checked).digest('hex'));
    return fields.toString();
  };
  assert.equal(verifyTgWebAppInitData(sign(42), candidate.token, candidate.chatId, now + 1).ok, true);
  assert.equal(verifyTgWebAppInitData(sign(43), candidate.token, candidate.chatId, now + 1).ok, false);
});
