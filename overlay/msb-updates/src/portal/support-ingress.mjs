// Приём обращения в поддержку до записи тикета.
// Вход: политика доступа, установки человека, текст, источник bot или web.
// Выход: код accepted, capability_denied или support_unavailable.
// Отдельной формы сайта нет: web вызывает эту же функцию.
// Бот: src/bot/support.mjs. Проверка: tests/tickets.test.mjs.

import { resolveSupportAccess } from './support-access.mjs';

export async function receiveSupportText({ tickets, access, clients, from, text, source = 'bot' }) {
  if (!tickets) return { code: 'support_unavailable' };
  const installations = await clients.listInstallations();
  const decision = await resolveSupportAccess({
    access,
    installations,
    tgUserId: from.id,
  });
  if (!decision.allowed) return { code: 'capability_denied' };
  const result = await tickets.accept({
    source,
    tgUserId: Number(from.id),
    username: from.username || null,
    name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null,
    text,
    installation: decision.installation,
  });
  return { code: 'accepted', ...result };
}
