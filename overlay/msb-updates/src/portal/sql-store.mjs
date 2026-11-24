// Запись тикетов в Postgres. Операции совпадают с memory-store.mjs.
// Вход: portal.withTransaction. Выход: те же поля строк.
// Правила очереди: portal/ticket-service.mjs. Проверка с базой: tests/tickets-sql.test.mjs.

import { randomUUID } from 'node:crypto';

function rowTicket(row) {
  if (!row) return null;
  return {
    id: row.id,
    tg_user_id: row.tg_user_id == null ? null : Number(row.tg_user_id),
    client_id: row.client_id,
    installation_id: row.installation_id,
    source: row.source,
    status: row.status,
    case_revision: Number(row.case_revision),
  };
}

export function createSqlStore(portal) {
  function tx(query) {
    return {
      async ensureClient({ tgUserId, username, name }) {
        const result = await query(
          `INSERT INTO clients (id, tg_user_id, username, name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tg_user_id) DO UPDATE
             SET username = EXCLUDED.username,
                 name = EXCLUDED.name,
                 updated_at = now()
           RETURNING id, tg_user_id, username, name`,
          [randomUUID(), Number(tgUserId), username, name],
        );
        return result.rows[0];
      },
      async ensureInstallation(installation, clientId) {
        const found = await query('SELECT id, status FROM installations WHERE id = $1', [installation.id]);
        if (found.rows[0]) return found.rows[0];
        const inserted = await query(
          `INSERT INTO installations
             (id, client_id, owner_tg_user_id, origin, provider, host, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING
           RETURNING id, status`,
          [
            installation.id,
            clientId,
            installation.owner_tg_user_id ?? null,
            installation.origin || 'support',
            installation.provider || null,
            installation.host || null,
            installation.status || 'ready',
          ],
        );
        if (inserted.rows[0]) return inserted.rows[0];
        const again = await query('SELECT id, status FROM installations WHERE id = $1', [installation.id]);
        return again.rows[0];
      },
      async getInstallation(id) {
        const result = await query('SELECT id, status FROM installations WHERE id = $1', [id]);
        return result.rows[0] || null;
      },
      async getOpenTicket(tgUserId) {
        const result = await query(
          `SELECT id, tg_user_id, client_id, installation_id, source, status, case_revision
             FROM tickets
            WHERE tg_user_id = $1 AND status = 'open'`,
          [Number(tgUserId)],
        );
        return rowTicket(result.rows[0]);
      },
      async insertTicket(fields) {
        const result = await query(
          `INSERT INTO tickets
             (id, client_id, installation_id, source, status, tg_user_id, case_revision)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, tg_user_id, client_id, installation_id, source, status, case_revision`,
          [
            randomUUID(),
            fields.clientId,
            fields.installationId,
            fields.source,
            fields.status,
            Number(fields.tgUserId),
            fields.caseRevision,
          ],
        );
        return rowTicket(result.rows[0]);
      },
      async updateTicket(id, patch) {
        const result = await query(
          `UPDATE tickets
              SET status = COALESCE($2, status),
                  case_revision = COALESCE($3, case_revision),
                  updated_at = now()
            WHERE id = $1
          RETURNING id, tg_user_id, client_id, installation_id, source, status, case_revision`,
          [id, patch.status ?? null, patch.caseRevision ?? null],
        );
        return rowTicket(result.rows[0]);
      },
      async getTicket(id) {
        const result = await query(
          `SELECT id, tg_user_id, client_id, installation_id, source, status, case_revision
             FROM tickets WHERE id = $1`,
          [id],
        );
        return rowTicket(result.rows[0]);
      },
      async insertMessage({ ticketId, direction, body }) {
        const result = await query(
          `INSERT INTO ticket_messages (id, ticket_id, direction, body)
           VALUES ($1, $2, $3, $4)
           RETURNING id, ticket_id, direction, body`,
          [randomUUID(), ticketId, direction, body],
        );
        return result.rows[0];
      },
      async listMessages(ticketId) {
        const result = await query(
          `SELECT id, ticket_id, direction, body, created_at
             FROM ticket_messages
            WHERE ticket_id = $1
            ORDER BY created_at, id`,
          [ticketId],
        );
        return result.rows;
      },
      async findOutbox(operationId) {
        const result = await query(
          `SELECT id, ticket_id, operation_id, status, payload
             FROM outbox WHERE operation_id = $1`,
          [operationId],
        );
        return result.rows[0] || null;
      },
      async listOutbox(ticketId) {
        const result = await query(
          `SELECT id, ticket_id, operation_id, status, payload
             FROM outbox WHERE ticket_id = $1
            ORDER BY created_at, id`,
          [ticketId],
        );
        return result.rows;
      },
      async insertOutbox({ ticketId, operationId, status, payload }) {
        const result = await query(
          `INSERT INTO outbox (id, ticket_id, kind, status, payload, operation_id)
           VALUES ($1, $2, 'send', $3, $4::jsonb, $5)
           RETURNING id, ticket_id, operation_id, status, payload`,
          [randomUUID(), ticketId, status, JSON.stringify(payload), operationId],
        );
        return result.rows[0];
      },
      async claimPending() {
        const result = await query(
          `UPDATE outbox
              SET status = 'processing', updated_at = now()
            WHERE id = (
              SELECT id FROM outbox
               WHERE status = 'pending'
               ORDER BY created_at
               FOR UPDATE SKIP LOCKED
               LIMIT 1
            )
          RETURNING id, ticket_id, operation_id, status, payload`,
        );
        const row = result.rows[0];
        if (!row) return null;
        const ticket = await query('SELECT tg_user_id FROM tickets WHERE id = $1', [row.ticket_id]);
        return { ...row, tg_user_id: ticket.rows[0] ? Number(ticket.rows[0].tg_user_id) : null };
      },
      async finishOutbox(id, status) {
        const result = await query(
          `UPDATE outbox
              SET status = $2, updated_at = now()
            WHERE id = $1 AND status = 'processing'
          RETURNING id, ticket_id, operation_id, status, payload`,
          [id, status],
        );
        return result.rows[0] || null;
      },
      async listOpen() {
        const result = await query(
          `SELECT id, tg_user_id, client_id, installation_id, source, status, case_revision
             FROM tickets
            WHERE status = 'open'
            ORDER BY updated_at DESC`,
        );
        return result.rows.map(rowTicket);
      },
      async getBackup(installationId) {
        const result = await query(
          `SELECT installation_id, schedule, last_success_at, object_ref, restore_requested_at
             FROM backup_accounts WHERE installation_id = $1`,
          [installationId],
        );
        return result.rows[0] || null;
      },
      async saveBackup({ installationId, schedule, objectRef, lastSuccessAt }) {
        const result = await query(
          `INSERT INTO backup_accounts (installation_id, schedule, last_success_at, object_ref)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (installation_id) DO UPDATE
             SET schedule = EXCLUDED.schedule,
                 last_success_at = EXCLUDED.last_success_at,
                 object_ref = EXCLUDED.object_ref,
                 updated_at = now()
           RETURNING installation_id, schedule, last_success_at, object_ref, restore_requested_at`,
          [installationId, schedule, lastSuccessAt, objectRef],
        );
        return result.rows[0];
      },
      async requestRestore(installationId) {
        const result = await query(
          `UPDATE backup_accounts
              SET restore_requested_at = now(), updated_at = now()
            WHERE installation_id = $1
          RETURNING installation_id, schedule, last_success_at, object_ref, restore_requested_at`,
          [installationId],
        );
        return result.rows[0] || null;
      },
    };
  }

  return {
    transaction(fn) {
      return portal.withTransaction((query) => fn(tx(query)));
    },
  };
}
