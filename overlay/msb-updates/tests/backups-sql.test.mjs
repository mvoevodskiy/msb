import test from 'node:test';
import assert from 'node:assert/strict';
import { openPortal } from '../src/portal/db.mjs';
import { createSqlStore } from '../src/portal/sql-store.mjs';
import { createBackupService } from '../src/portal/backups.mjs';

const url = process.env.PORTAL_DATABASE_URL || '';

test('postgres backup row stores the location only', { skip: url ? false : 'PORTAL_DATABASE_URL is not set' }, async () => {
  const portal = await openPortal(url);
  const backups = createBackupService(createSqlStore(portal));
  const installation = {
    id: `srv_backup_${Date.now()}`,
    owner_tg_user_id: 42,
    status: 'ready',
    origin: 'setup',
  };
  try {
    await backups.report({
      installation,
      schedule: 'daily',
      objectRef: 's3://bucket/sql',
      lastSuccessAt: '2026-11-24T12:00:00.000Z',
    });
    await backups.report({
      installation: { ...installation, status: 'failed' },
      schedule: 'daily',
      objectRef: 's3://bucket/sql',
      lastSuccessAt: '2026-11-24T12:00:00.000Z',
    });
    const row = await backups.requestRestore(installation.id);
    assert.equal(row.object_ref, 's3://bucket/sql');
    assert.ok(row.restore_requested_at);
    const status = await portal.withTransaction(async (query) => {
      const result = await query('SELECT status FROM installations WHERE id = $1', [installation.id]);
      return result.rows[0].status;
    });
    assert.equal(status, 'ready');
  } finally {
    await portal.close();
  }
});
