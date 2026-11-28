// Проверка возможности Портала для одной установки.
// Вход: installation (id, {id} или пусто) и capability: support, updates, backup.
// Выход: { allowed, reason }.
// open разрешает всё, в том числе обращение без установки.
// restricted пускает только неистёкшую строку installation_capabilities.
// Установщик этот модуль не вызывает. Его вызовут поддержка, обновления и копии.
// Поиск права: portal/db.mjs findGrant. Проверка: tests/portal-access.test.mjs.

export const CAPABILITIES = Object.freeze(['support', 'updates', 'backup']);

export function decideAccess({ policy, capability, installation, grant, now = new Date() }) {
  if (!CAPABILITIES.includes(capability)) {
    return { allowed: false, reason: 'unknown_capability' };
  }
  if (policy === 'open') return { allowed: true, reason: 'open' };
  if (policy !== 'restricted' || !installation) {
    return { allowed: false, reason: 'capability_denied' };
  }
  if (!grant) return { allowed: false, reason: 'capability_denied' };
  if (grant.valid_until) {
    const until = new Date(grant.valid_until);
    if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) {
      return { allowed: false, reason: 'capability_denied' };
    }
  }
  return { allowed: true, reason: 'grant' };
}

function installationId(installation) {
  if (!installation) return null;
  if (typeof installation === 'object') return installation.id || null;
  return String(installation);
}

export function createAccess({ policy, findGrant }) {
  return {
    policy,
    async allow(installation, capability) {
      const id = installationId(installation);
      const grant = policy === 'restricted' && id && findGrant
        ? await findGrant(id, capability)
        : null;
      return decideAccess({
        policy,
        capability,
        installation: id ? { id } : null,
        grant,
      });
    },
  };
}
