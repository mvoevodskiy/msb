import test from 'node:test';
import assert from 'node:assert/strict';
import { openPortal } from '../src/portal/db.mjs';
import { createSqlStore } from '../src/portal/sql-store.mjs';
import { createTicketService } from '../src/portal/ticket-service.mjs';

const url = process.env.PORTAL_DATABASE_URL || '';

test('postgres ticket queue matches the memory rules', { skip: url ? false : 'PORTAL_DATABASE_URL is not set' }, async () => {
  const portal = await openPortal(url);
  const tickets = createTicketService(createSqlStore(portal));
  try {
    const suffix = Date.now();
    const accepted = await tickets.accept({
      source: 'web',
      tgUserId: 8800000000000 + (suffix % 1000),
      text: 'из формы',
      installation: { id: `srv_sql_${suffix}`, owner_tg_user_id: 4, status: 'ready', origin: 'setup' },
    });
    const more = await tickets.accept({
      source: 'bot',
      tgUserId: accepted.ticket.tg_user_id,
      text: 'ещё строка',
      installation: { id: `srv_sql_${suffix}`, status: 'failed', origin: 'setup' },
    });
    assert.equal(more.ticket.id, accepted.ticket.id);
    assert.equal(await tickets.installationStatus(`srv_sql_${suffix}`), 'ready');
    await tickets.reply({
      ticketId: accepted.ticket.id,
      operationId: `op_${suffix}`,
      text: 'ответ',
      expectedRevision: more.ticket.case_revision,
    });
    const lost = await tickets.deliverNext(async () => ({ outcome: 'uncertain' }));
    assert.equal(lost.status, 'uncertain');
    assert.equal(await tickets.deliverNext(async () => ({ ok: true })), null);
    await tickets.close(accepted.ticket.id);
    assert.equal(await tickets.installationStatus(`srv_sql_${suffix}`), 'ready');
  } finally {
    await portal.close();
  }
});
