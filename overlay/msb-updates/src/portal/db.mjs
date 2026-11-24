// Подключение схемы Портала и чтение права установки.
// Вход: PORTAL_DATABASE_URL. Пустой адрес — база выключена, findGrant возвращает null.
// Выход: { enabled, findGrant, withTransaction, close }.
// Схему берёт из schema.sql через schema.mjs. Проверка доступа: portal/access.mjs.
// Запуск: bin/serve.mjs. Проверка разбора схемы: tests/portal-access.test.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySchema } from './schema.mjs';

const schemaSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');

export function portalSchemaSql() {
  return schemaSql;
}

export async function openPortal(databaseUrl) {
  const url = String(databaseUrl || '').trim();
  if (!url) {
    return {
      enabled: false,
      async findGrant() {
        return null;
      },
      async close() {},
      async withTransaction() {
        throw Object.assign(new Error('portal_unavailable'), { code: 'portal_unavailable' });
      },
    };
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(814201)');
    await applySchema((statement) => client.query(statement), schemaSql);
    await client.query('SELECT pg_advisory_unlock(814201)');
  } catch (err) {
    await client.query('SELECT pg_advisory_unlock(814201)').catch(() => {});
    client.release();
    await pool.end().catch(() => {});
    throw err;
  }
  client.release();
  return {
    enabled: true,
    async findGrant(installationId, capability) {
      const result = await pool.query(
        `SELECT valid_until
           FROM installation_capabilities
          WHERE installation_id = $1 AND capability = $2`,
        [installationId, capability],
      );
      return result.rows[0] || null;
    },
    async close() {
      await pool.end();
    },
    async withTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn((text, params) => client.query(text, params));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
