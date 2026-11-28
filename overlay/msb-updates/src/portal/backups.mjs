// Учёт облачной копии. Архив Портал не принимает и не скачивает.
// Вход: установка, расписание, время успеха, ссылка на объект.
// Выход: строка учёта. Восстановление только отмечает запрос оператора.
// Перед записью вызывающий проверяет allow(installation, backup).
// Проверка: tests/backups.test.mjs.

function coded(code) {
  return Object.assign(new Error(code), { code, status: 400 });
}

const REFUSED = new Set(['archive', 'content', 'bytes', 'file', 'data', 'blob', 'body']);

export function normalizeBackupReport(body) {
  const input = body && typeof body === 'object' ? body : {};
  for (const key of Object.keys(input)) {
    if (REFUSED.has(key)) throw coded('archive_refused');
  }
  const schedule = input.schedule == null ? null : String(input.schedule).trim();
  const objectRef = input.object_ref == null ? null : String(input.object_ref).trim();
  if (schedule && schedule.length > 200) throw coded('bad_schedule');
  if (objectRef && (objectRef.length > 500 || /[\r\n]/.test(objectRef))) throw coded('bad_object_ref');
  let lastSuccessAt = null;
  if (input.last_success_at) {
    const date = new Date(input.last_success_at);
    if (Number.isNaN(date.getTime())) throw coded('bad_time');
    lastSuccessAt = date.toISOString();
  }
  return { schedule: schedule || null, objectRef: objectRef || null, lastSuccessAt };
}

function iso(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function publicBackup(row) {
  if (!row) return null;
  return {
    installation_id: row.installation_id,
    schedule: row.schedule,
    last_success_at: iso(row.last_success_at),
    object_ref: row.object_ref,
    restore_requested_at: iso(row.restore_requested_at),
  };
}

export function createBackupService(store) {
  return {
    async report({ installation, schedule, objectRef, lastSuccessAt }) {
      return store.transaction(async (tx) => {
        const client = await tx.ensureClient({
          tgUserId: installation.owner_tg_user_id,
          username: installation.owner_username || null,
          name: installation.owner_name || null,
        });
        await tx.ensureInstallation(installation, client.id);
        return tx.saveBackup({
          installationId: installation.id,
          schedule,
          objectRef,
          lastSuccessAt,
        });
      });
    },
    async get(installationId) {
      return store.transaction(async (tx) => tx.getBackup(installationId));
    },
    async requestRestore(installationId) {
      return store.transaction(async (tx) => {
        const saved = await tx.requestRestore(installationId);
        if (!saved) throw Object.assign(new Error('no_backup'), { code: 'no_backup' });
        return saved;
      });
    },
  };
}
