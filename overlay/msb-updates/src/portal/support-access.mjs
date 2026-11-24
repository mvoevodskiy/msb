// Кому из установок человека открыта поддержка.
// Вход: access.allow и список установок. Выход: { allowed, reason, installation }.
// open пускает и без установки. restricted требует право support хотя бы на одной.
// Приём текста: portal/support-ingress.mjs. Проверка: tests/tickets.test.mjs.

export async function resolveSupportAccess({ access, installations, tgUserId }) {
  const owned = (installations || []).filter((item) => Number(item.owner_tg_user_id) === Number(tgUserId));
  if (access.policy === 'open') {
    return { allowed: true, reason: 'open', installation: owned[0] || null };
  }
  for (const installation of owned) {
    const decision = await access.allow(installation, 'support');
    if (decision.allowed) return { ...decision, installation };
  }
  return { allowed: false, reason: 'capability_denied', installation: null };
}
