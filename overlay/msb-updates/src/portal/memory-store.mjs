// Память для проверок тикетов. Те же операции, что у sql-store.mjs.
// Вход: transaction(fn). Выход: строки тикета, сообщения и очереди.
// Проверка: tests/tickets.test.mjs.

import { randomUUID } from 'node:crypto';

function copy(value) {
  return value == null ? value : structuredClone(value);
}

export function createMemoryStore() {
  const state = {
    clients: [],
    installations: [],
    tickets: [],
    messages: [],
    outbox: [],
  };
  let chain = Promise.resolve();

  function tx() {
    return {
      async ensureClient({ tgUserId, username, name }) {
        let row = state.clients.find((item) => item.tg_user_id === Number(tgUserId));
        if (!row) {
          row = {
            id: randomUUID(),
            tg_user_id: Number(tgUserId),
            username: username || null,
            name: name || null,
          };
          state.clients.push(row);
        } else {
          row.username = username || row.username;
          row.name = name || row.name;
        }
        return copy(row);
      },
      async ensureInstallation(installation, clientId) {
        let row = state.installations.find((item) => item.id === installation.id);
        if (!row) {
          row = {
            id: installation.id,
            client_id: clientId,
            owner_tg_user_id: installation.owner_tg_user_id ?? null,
            origin: installation.origin || 'support',
            provider: installation.provider || null,
            host: installation.host || null,
            status: installation.status || 'ready',
          };
          state.installations.push(row);
        }
        return copy(row);
      },
      async getInstallation(id) {
        return copy(state.installations.find((item) => item.id === id) || null);
      },
      async getOpenTicket(tgUserId) {
        return copy(state.tickets.find((item) => item.tg_user_id === Number(tgUserId) && item.status === 'open') || null);
      },
      async insertTicket(fields) {
        const row = {
          id: randomUUID(),
          tg_user_id: Number(fields.tgUserId),
          client_id: fields.clientId,
          installation_id: fields.installationId,
          source: fields.source,
          status: fields.status,
          case_revision: fields.caseRevision,
          created_at: new Date().toISOString(),
        };
        state.tickets.push(row);
        return copy(row);
      },
      async updateTicket(id, patch) {
        const row = state.tickets.find((item) => item.id === id);
        if (!row) return null;
        if (patch.status) row.status = patch.status;
        if (patch.caseRevision != null) row.case_revision = patch.caseRevision;
        return copy(row);
      },
      async getTicket(id) {
        return copy(state.tickets.find((item) => item.id === id) || null);
      },
      async insertMessage({ ticketId, direction, body }) {
        const row = {
          id: randomUUID(),
          ticket_id: ticketId,
          direction,
          body,
          created_at: new Date().toISOString(),
        };
        state.messages.push(row);
        return copy(row);
      },
      async listMessages(ticketId) {
        return state.messages.filter((item) => item.ticket_id === ticketId).map(copy);
      },
      async findOutbox(operationId) {
        return copy(state.outbox.find((item) => item.operation_id === operationId) || null);
      },
      async listOutbox(ticketId) {
        return state.outbox.filter((item) => item.ticket_id === ticketId).map(copy);
      },
      async insertOutbox({ ticketId, operationId, status, payload }) {
        const row = {
          id: randomUUID(),
          ticket_id: ticketId,
          operation_id: operationId,
          status,
          payload: copy(payload),
          created_at: new Date().toISOString(),
        };
        state.outbox.push(row);
        return copy(row);
      },
      async claimPending() {
        const row = state.outbox.find((item) => item.status === 'pending');
        if (!row) return null;
        row.status = 'processing';
        const ticket = state.tickets.find((item) => item.id === row.ticket_id);
        return { ...copy(row), tg_user_id: ticket?.tg_user_id ?? null };
      },
      async finishOutbox(id, status) {
        const row = state.outbox.find((item) => item.id === id && item.status === 'processing');
        if (!row) return null;
        row.status = status;
        return copy(row);
      },
      async listOpen() {
        return state.tickets.filter((item) => item.status === 'open').map(copy);
      },
    };
  }

  return {
    transaction(fn) {
      const run = chain.then(() => fn(tx()));
      chain = run.then(() => {}, () => {});
      return run;
    },
  };
}
