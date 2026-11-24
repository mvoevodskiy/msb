// Разбор schema.sql на отдельные команды.
// Вход: текст схемы. Выход: массив SQL без завершающей точки с запятой.
// Применяет portal/db.mjs. Проверка: tests/portal-access.test.mjs.

export function schemaStatements(sql) {
  const withoutComments = String(sql)
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return withoutComments
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function applySchema(query, sql) {
  const statements = schemaStatements(sql);
  for (const statement of statements) {
    await query(statement);
  }
  return statements;
}
