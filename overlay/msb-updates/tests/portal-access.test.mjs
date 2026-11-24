import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, createAccess, decideAccess } from '../src/portal/access.mjs';
import { portalSchemaSql } from '../src/portal/db.mjs';
import { applySchema, schemaStatements } from '../src/portal/schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = new Date('2026-11-24T12:00:00Z');

test('open policy allows support, updates and backup without a grant', () => {
  assert.deepEqual(CAPABILITIES, ['support', 'updates', 'backup']);
  for (const capability of CAPABILITIES) {
    assert.deepEqual(
      decideAccess({ policy: 'open', capability, installation: null, grant: null, now }),
      { allowed: true, reason: 'open' },
    );
  }
});

test('restricted policy denies a missing or expired grant', () => {
  const installation = { id: 'srv_1' };
  assert.deepEqual(
    decideAccess({ policy: 'restricted', capability: 'updates', installation, grant: null, now }),
    { allowed: false, reason: 'capability_denied' },
  );
  assert.deepEqual(
    decideAccess({ policy: 'restricted', capability: 'support', installation: null, grant: { valid_until: null }, now }),
    { allowed: false, reason: 'capability_denied' },
  );
  assert.deepEqual(
    decideAccess({
      policy: 'restricted',
      capability: 'backup',
      installation,
      grant: { valid_until: '2026-11-24T11:00:00Z' },
      now,
    }),
    { allowed: false, reason: 'capability_denied' },
  );
  assert.deepEqual(
    decideAccess({
      policy: 'restricted',
      capability: 'backup',
      installation,
      grant: { valid_until: '2026-12-01T00:00:00Z' },
      now,
    }),
    { allowed: true, reason: 'grant' },
  );
  assert.deepEqual(
    decideAccess({ policy: 'restricted', capability: 'billing', installation, grant: { valid_until: null }, now }),
    { allowed: false, reason: 'unknown_capability' },
  );
});

test('access lookup reads only the requested capability', async () => {
  const grants = new Map([['srv_1:support', { valid_until: null }]]);
  const seen = [];
  const access = createAccess({
    policy: 'restricted',
    findGrant: async (installationId, capability) => {
      seen.push([installationId, capability]);
      return grants.get(`${installationId}:${capability}`) || null;
    },
  });
  assert.deepEqual(await access.allow('srv_1', 'support'), { allowed: true, reason: 'grant' });
  assert.deepEqual(await access.allow({ id: 'srv_1' }, 'updates'), { allowed: false, reason: 'capability_denied' });
  assert.deepEqual(await access.allow(null, 'support'), { allowed: false, reason: 'capability_denied' });
  const open = createAccess({ policy: 'open', findGrant: async () => { throw new Error('lookup'); } });
  assert.deepEqual(await open.allow(null, 'updates'), { allowed: true, reason: 'open' });
  assert.deepEqual(seen, [['srv_1', 'support'], ['srv_1', 'updates']]);
});

test('portal schema creates the client, ticket and grant tables', async () => {
  const statements = schemaStatements(portalSchemaSql());
  const applied = [];
  assert.deepEqual(await applySchema(async (statement) => { applied.push(statement); }, portalSchemaSql()), statements);
  const text = applied.join('\n');
  for (const table of ['clients', 'installations', 'tickets', 'ticket_messages', 'outbox', 'installation_capabilities']) {
    assert.match(text, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(text, /CREATE TABLE IF NOT EXISTS installation_capabilities\b/);
  assert.match(text, /case_revision/);
  assert.match(text, /tickets_one_open_tg/);
  assert.match(text, /outbox_operation/);
  assert.ok(applied.length >= 6);
});

test('installer sources do not offer an IIA install', () => {
  assert.equal(fs.existsSync(path.join(root, 'src/ssh/iia-migrate.mjs')), false);
  const files = [
    'src/bot/app.mjs',
    'src/ssh/worker.mjs',
    'src/api/server.mjs',
    'web/public/app.js',
    'README.md',
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /Миграция IIA|iia-migrate|IIA_MIGRATED/);
  }
});
