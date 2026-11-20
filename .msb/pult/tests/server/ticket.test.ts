import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptTgLoginTicket,
  burnTgLoginTicket,
  issueTgLoginTicket,
  TG_LOGIN_ONCE_TTL_MS,
  TG_LOGIN_TTL_MS,
} from '../../src/server/auth.ts';
import { kvSet, openDb } from '../../src/server/db.ts';

test('билет once сгорает; burn снимает без проверки; старый формат читается', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pult-ticket-'));
  try {
    const db = openDb(dir);
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);

    const multi = issueTgLoginTicket(db, now, { ttlMs: TG_LOGIN_TTL_MS, once: false });
    assert.equal(acceptTgLoginTicket(db, multi, now + 1000), true);
    burnTgLoginTicket(db, multi);
    assert.equal(acceptTgLoginTicket(db, multi, now + 2000), false, 'burn снял многоразовый');

    const once = issueTgLoginTicket(db, now, { ttlMs: TG_LOGIN_ONCE_TTL_MS, once: true });
    assert.equal(acceptTgLoginTicket(db, once, now + 1000), true);
    assert.equal(acceptTgLoginTicket(db, once, now + 2000), false, 'одноразовый сгорел');

    const live = issueTgLoginTicket(db, now, { ttlMs: TG_LOGIN_ONCE_TTL_MS, once: true });
    burnTgLoginTicket(db, live);
    assert.equal(acceptTgLoginTicket(db, live, now + 1000), false, 'burn без accept');

    const stale = issueTgLoginTicket(db, now, { ttlMs: 1000, once: false });
    assert.equal(acceptTgLoginTicket(db, stale, now + 2000), false);

    const legacyTok = 'legacyTicketTokenValue________________';
    const hash = createHash('sha256').update(legacyTok).digest('hex');
    kvSet(db, `tg_login:${hash}`, String(now + 60_000));
    assert.equal(acceptTgLoginTicket(db, legacyTok, now + 1000), true, 'старый формат');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
