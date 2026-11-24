// Подключение схемы Портала и чтение права установки.
// Вход: PORTAL_DATABASE_URL. Пустой адрес — база выключена, findGrant возвращает null.
// Выход: { enabled, findGrant(installationId, capability), close() }.
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
    };
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url });
  try {
    await applySchema((statement) => pool.query(statement), schemaSql);
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
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
  };
}
