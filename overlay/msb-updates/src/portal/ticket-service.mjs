// Правила тикета поверх хранилища.
// Вход: человек, текст, источник bot|web, установка если есть.
// Выход: открытый тикет, сообщение, очередь отправки.
// Закрытие не меняет статус установки. Неизвестный исход отправки не ставится в повтор.
// Проверка: tests/tickets.test.mjs. Бот: src/bot/support.mjs. Страница: src/crm/http.mjs.

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function checkText(text) {
  const body = String(text ?? '').trim();
  if (!body) throw coded('empty_text');
  if (body.length > 4000) throw coded('text_too_long');
  return body;
}

async function acceptOnce(store, input) {
  const body = checkText(input.text);
  if (input.source !== 'bot' && input.source !== 'web') throw coded('bad_source');
  return store.transaction(async (tx) => {
    const client = await tx.ensureClient({
      tgUserId: input.tgUserId,
      username: input.username || null,
      name: input.name || null,
    });
    let installationId = null;
    if (input.installation?.id) {
      await tx.ensureInstallation(input.installation, client.id);
      installationId = input.installation.id;
    }
    let ticket = await tx.getOpenTicket(input.tgUserId);
    let created = false;
    if (!ticket) {
      ticket = await tx.insertTicket({
        tgUserId: input.tgUserId,
        clientId: client.id,
        installationId,
        source: input.source,
        status: 'open',
        caseRevision: 1,
      });
      created = true;
    } else {
      ticket = await tx.updateTicket(ticket.id, { caseRevision: Number(ticket.case_revision) + 1 });
    }
    const message = await tx.insertMessage({ ticketId: ticket.id, direction: 'in', body });
    return { ticket, message, created };
  });
}

export function createTicketService(store) {
  return {
    store,
    async accept(input) {
      try {
        return await acceptOnce(store, input);
      } catch (err) {
        if (err.code !== '23505') throw err;
        return acceptOnce(store, input);
      }
    },
    async reply({ ticketId, operationId, text, expectedRevision }) {
      const body = checkText(text);
      if (!operationId) throw coded('bad_operation');
      return store.transaction(async (tx) => {
        const ticket = await tx.getTicket(ticketId);
        if (!ticket || ticket.status !== 'open') throw coded('ticket_closed');
        const existing = await tx.findOutbox(operationId);
        if (existing) {
          const same = existing.payload?.text === body && existing.ticket_id === ticketId;
          if (!same) throw coded('IDEMPOTENCY_CONFLICT');
          return { outbox: existing, duplicate: true };
        }
        if (Number(expectedRevision) !== Number(ticket.case_revision)) throw coded('REVISION_CONFLICT');
        const rows = await tx.listOutbox(ticketId);
        if (rows.some((row) => row.status === 'uncertain' || row.status === 'processing')) {
          throw coded('PREVIOUS_UNRESOLVED');
        }
        const outbox = await tx.insertOutbox({
          ticketId,
          operationId,
          status: 'pending',
          payload: { text: body },
        });
        return { outbox, duplicate: false };
      });
    },
    async close(ticketId) {
      return store.transaction(async (tx) => {
        const ticket = await tx.getTicket(ticketId);
        if (!ticket) throw coded('not_found');
        if (ticket.status === 'closed') return ticket;
        return tx.updateTicket(ticket.id, {
          status: 'closed',
          caseRevision: Number(ticket.case_revision) + 1,
        });
      });
    },
    async get(ticketId) {
      return store.transaction(async (tx) => {
        const ticket = await tx.getTicket(ticketId);
        if (!ticket) return null;
        return {
          ...ticket,
          messages: await tx.listMessages(ticketId),
          outbox: await tx.listOutbox(ticketId),
        };
      });
    },
    async listOpen() {
      return store.transaction(async (tx) => {
        const tickets = await tx.listOpen();
        const out = [];
        for (const ticket of tickets) {
          const messages = await tx.listMessages(ticket.id);
          const last = [...messages].reverse().find((item) => item.direction === 'in');
          out.push({ ...ticket, preview: last?.body || '' });
        }
        return out;
      });
    },
    async installationStatus(installationId) {
      return store.transaction(async (tx) => (await tx.getInstallation(installationId))?.status || null);
    },
    async deliverNext(send) {
      const claimed = await store.transaction(async (tx) => tx.claimPending());
      if (!claimed) return null;
      let status = 'failed';
      try {
        const result = await send(claimed);
        if (result?.outcome === 'uncertain') status = 'uncertain';
        else if (result?.ok) status = 'sent';
      } catch (err) {
        status = err?.code === 'OUTCOME_UNKNOWN' ? 'uncertain' : 'failed';
      }
      return store.transaction(async (tx) => {
        const finished = await tx.finishOutbox(claimed.id, status);
        if (status === 'sent') {
          await tx.insertMessage({ ticketId: claimed.ticket_id, direction: 'out', body: claimed.payload.text });
        }
        return finished;
      });
    },
  };
}
