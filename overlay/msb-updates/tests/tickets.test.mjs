import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createAccess } from '../src/portal/access.mjs';
import { createMemoryStore } from '../src/portal/memory-store.mjs';
import { createTicketService } from '../src/portal/ticket-service.mjs';
import { receiveSupportText } from '../src/portal/support-ingress.mjs';
import { createClientStore } from '../src/store/clients.mjs';
import { createServer } from '../src/api/server.mjs';
import { loadConfig } from '../src/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function service() {
  return createTicketService(createMemoryStore());
}

test('an open ticket takes the next message and a closed one starts another', async () => {
  const tickets = service();
  const access = createAccess({ policy: 'open', findGrant: async () => null });
  const clients = { listInstallations: async () => [] };
  const from = { id: 7, username: 'ann', first_name: 'Анна' };
  const first = await receiveSupportText({ tickets, access, clients, from, text: 'не стартует', source: 'bot' });
  const second = await receiveSupportText({ tickets, access, clients, from, text: 'всё ещё нет', source: 'web' });
  assert.equal(first.code, 'accepted');
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.ticket.id, first.ticket.id);
  assert.equal(second.ticket.case_revision, 2);
  await tickets.close(first.ticket.id);
  const third = await receiveSupportText({ tickets, access, clients, from, text: 'новое', source: 'web' });
  assert.equal(third.created, true);
  assert.notEqual(third.ticket.id, first.ticket.id);
});

test('restricted support needs a grant and does not open a ticket without it', async () => {
  const tickets = service();
  const access = createAccess({
    policy: 'restricted',
    findGrant: async (id, capability) => (id === 'srv_ok' && capability === 'support' ? { valid_until: null } : null),
  });
  const clients = {
    listInstallations: async () => [{ id: 'srv_no', owner_tg_user_id: 7, status: 'ready' }],
  };
  const denied = await receiveSupportText({
    tickets, access, clients, from: { id: 7 }, text: 'помощь', source: 'bot',
  });
  assert.equal(denied.code, 'capability_denied');
  assert.equal((await tickets.listOpen()).length, 0);
  clients.listInstallations = async () => [{ id: 'srv_ok', owner_tg_user_id: 7, status: 'ready' }];
  const allowed = await receiveSupportText({
    tickets, access, clients, from: { id: 7 }, text: 'помощь', source: 'bot',
  });
  assert.equal(allowed.code, 'accepted');
  assert.equal(allowed.ticket.installation_id, 'srv_ok');
});

test('reply is idempotent, uncertain delivery is not retried, close keeps installation status', async () => {
  const tickets = service();
  const installation = { id: 'srv_1', owner_tg_user_id: 3, status: 'ready', origin: 'setup' };
  const accepted = await tickets.accept({
    source: 'bot',
    tgUserId: 3,
    text: 'нужна помощь',
    installation,
  });
  const reply = await tickets.reply({
    ticketId: accepted.ticket.id,
    operationId: 'op-1',
    text: 'смотрим',
    expectedRevision: accepted.ticket.case_revision,
  });
  const again = await tickets.reply({
    ticketId: accepted.ticket.id,
    operationId: 'op-1',
    text: 'смотрим',
    expectedRevision: accepted.ticket.case_revision,
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.outbox.id, reply.outbox.id);
  await assert.rejects(
    () => tickets.reply({
      ticketId: accepted.ticket.id,
      operationId: 'op-1',
      text: 'другой текст',
      expectedRevision: accepted.ticket.case_revision,
    }),
    (err) => err.code === 'IDEMPOTENCY_CONFLICT',
  );
  await assert.rejects(
    () => tickets.reply({
      ticketId: accepted.ticket.id,
      operationId: 'op-2',
      text: 'рано',
      expectedRevision: 99,
    }),
    (err) => err.code === 'REVISION_CONFLICT',
  );
  const uncertain = await tickets.deliverNext(async () => {
    throw Object.assign(new Error('lost'), { code: 'OUTCOME_UNKNOWN' });
  });
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(await tickets.deliverNext(async () => ({ ok: true })), null);
  await assert.rejects(
    () => tickets.reply({
      ticketId: accepted.ticket.id,
      operationId: 'op-3',
      text: 'ещё раз',
      expectedRevision: accepted.ticket.case_revision,
    }),
    (err) => err.code === 'PREVIOUS_UNRESOLVED',
  );
  await tickets.close(accepted.ticket.id);
  assert.equal(installation.status, 'ready');
  assert.equal(await tickets.installationStatus('srv_1'), 'ready');
  const closed = await tickets.get(accepted.ticket.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.messages.some((item) => item.direction === 'out'), false);
});

test('a confirmed reply is stored once and shown to the operator', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msb-ticket-crm-'));
  const clients = createClientStore(dir);
  await clients.upsertFromTelegram({ id: 5, username: 'petr', first_name: 'Пётр' });
  const installation = await clients.createInstallation({
    owner_tg_user_id: 5,
    owner_name: 'Пётр',
    origin: 'setup',
    host: '203.0.113.20',
    status: 'ready',
  });
  const tickets = service();
  const access = createAccess({ policy: 'open', findGrant: async () => null });
  await receiveSupportText({
    tickets,
    access,
    clients,
    from: { id: 5, first_name: 'Пётр' },
    text: 'сервер молчит',
    source: 'bot',
  });
  const config = loadConfig({ CRM_PASSWORD: 'crm-secret-value', PUBLIC_BASE_URL: 'http://127.0.0.1' });
  const server = createServer({
    config,
    clients,
    tickets,
    auth: { resolveBearer: async () => null, hasScope: () => false },
    releases: {},
    intents: {},
    worker: {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const logged = await fetch(`${base}/crm/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=crm-secret-value',
      redirect: 'manual',
    });
    const cookie = (logged.headers.get('set-cookie') || '').split(';')[0];
    const list = await fetch(`${base}/crm`, { headers: { cookie } });
    const listHtml = await list.text();
    assert.match(listHtml, /сервер молчит/);
    const id = listHtml.match(/\/crm\/tickets\/([^"]+)/)[1];
    const page = await fetch(`${base}/crm/tickets/${id}`, { headers: { cookie } });
    const html = await page.text();
    const operationId = html.match(/name="operation_id" value="([^"]+)"/)[1];
    const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
    const revision = html.match(/name="expected_revision" value="([^"]+)"/)[1];
    const sent = await fetch(`${base}/crm/tickets/${id}/reply`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, operation_id: operationId, expected_revision: revision, text: 'проверил' }),
      redirect: 'manual',
    });
    assert.equal(sent.status, 303);
    const duplicate = await fetch(`${base}/crm/tickets/${id}/reply`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, operation_id: operationId, expected_revision: revision, text: 'проверил' }),
      redirect: 'manual',
    });
    assert.equal(duplicate.status, 303);
    const delivered = await tickets.deliverNext(async () => ({ ok: true }));
    assert.equal(delivered.status, 'sent');
    assert.equal(await tickets.deliverNext(async () => ({ ok: true })), null);
    const after = await tickets.get(id);
    assert.equal(after.messages.filter((item) => item.direction === 'out' && item.body === 'проверил').length, 1);
    const closed = await fetch(`${base}/crm/tickets/${id}/close`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    });
    assert.equal(closed.status, 303);
    assert.equal((await clients.getInstallation(installation.id)).status, 'ready');
  } finally {
    server.close();
  }
});

test('there is no separate website form route', () => {
  const server = fs.readFileSync(path.join(root, 'src/api/server.mjs'), 'utf8');
  assert.match(server, /\/telegram\/support/);
  assert.doesNotMatch(server, /\/support\/form|\/crm\/form/);
  const installer = fs.readFileSync(path.join(root, 'src/bot/app.mjs'), 'utf8');
  assert.doesNotMatch(installer, /Поддержка|support/);
});
