# Эталонные сценарии open-core

[← Вход ядра](../../src/main.mjs) · [Telegram](../../src/telegram/README.md) ·
[Overlay](../../../../overlay/bot/ext/README.md) · [Release checks](../../../../tools/release/README.md)

Набор проверяет требуемое поведение настоящих handlers/runner/overlay с fake
Telegram, Deepgram и CLI. Ожидания не подгоняются под заглушки и не скрываются
`skip`/`todo`. Ошибки прежнего адаптера — обход owner-check, потеря сессии при
ошибке и автоматический replay — не считаются эталоном.

## Сценарий → реализация → тест

| Сценарий | Маршрут | Проверка |
|---|---|---|
| Обычный reply, queued цитаты и reply «стоп» | [Контракт входов](parity-inputs-contract.txt) → inbox/executeTurn | [inbox lifecycle](../inbox-lifecycle.test.mjs), [формы](../menu-handlers.test.mjs) |
| Голос и прежний preview/reply | [Telegram voice](../../src/telegram/README.md#голос) → [STT](../../src/media/README.md) → общий ход | [voice-progress](voice-progress.test.mjs), [voice-lifecycle](../voice-lifecycle.test.mjs), [stt](../stt.test.mjs) |
| Typing/status, final edit/chunks/footer | [Жизненный цикл](../../src/telegram/README.md#жизненный-цикл-хода) → progress/response | [voice-progress](voice-progress.test.mjs), [response-delivery](../response-delivery.test.mjs), [presentation-retry](../presentation-retry.test.mjs) |
| `/stop` во время долгого хода | `bot.start` / polling → controller → runner abort → cleanup/unlock | [stop-polling](stop-polling.test.mjs), [turn-lifecycle](../turn-lifecycle.test.mjs), [claude-abort](../claude-abort.test.mjs) |
| Claude↔Codex, owner, failed login, error/session | [Интеграция](../../../../overlay/bot/ext/README.md#интеграция-telegram) → shim/adapter | [provider-switch](../../../../overlay/bot/ext/tests/reference/provider-switch.test.mjs), [codex-session](../../../../overlay/bot/ext/tests/codex-session.test.mjs) |
| Настройки → Движки → Codex | core renderer/router → provider view → existing callback | [engine-menu](../../../../overlay/bot/ext/tests/reference/engine-menu.test.mjs) |
| Context, MAX, forms и shared profile | [Agent](../../src/agent/README.md), [Telegram](../../src/telegram/README.md), [Shared](../../shared/README.md) | [codex-context](../codex-context.test.mjs), [menu-handlers](../menu-handlers.test.mjs), [runtime-profile](../runtime-profile.test.mjs) |

Пояснения к ранним commits текущего аудита, old provenance, RED→GREEN и границы:
[parity-audit-notes.txt](parity-audit-notes.txt). Это история проверок, не замена
навигации у исходников и не утверждение полного паритета.

## Основа эталона

Исходный open-core: `0bc2c9493063043bca866ca8ead6ee2aec6f3457`.
Старый master: `00f081f2220d0e6d3a186e8e1bb447b57acd6ebf`.
Bundle `.iia/bot/index.js` совпал с vendor blob `a3285b1062653226c4c4665d4efdb79803a47220`;
исторический deobfuscated.js — blob `73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11`.
Закрытый bundle удалён upstream-коммитом `ace619d`. Эталон теперь закреплён
явными assertions этих тестов и указанной provenance; для запуска старый код
не нужен и в snapshot выпуска не включается. Проверки поведения сохранены.

Участки эталона: voice 119871–119990; STT 102108–102247; status/typing
105675 / 106170 / 106834 / 109948–110061; доставка 106557–106644; footer
3362–3384; stop 118208–118263. Переключение CLI — прежний overlay.
Строка Codex в «Движках» — отдельно запрошенное расширение прежнего экрана.

## Запуск и результаты

Из корня source checkout с установленными совместимыми зависимостями:

```sh
node --test .msb/bot/tests/reference/*.test.mjs overlay/bot/ext/tests/reference/*.test.mjs
```

Обычные `npm test` ядра и `test:ext` не включают вложенный reference-набор.
В [release pipeline](../../../../tools/release/README.md) core, overlay и reference
запускаются на snapshot того же commit, что экспортированный runtime и инструменты.
Текущий результат выпуска — его `checks/results/verification.json`, привязанный к manifest.

[baseline.json](baseline.json), [stop-checkpoint](stop-checkpoint.json),
[progress-checkpoint](progress-checkpoint.json), [voice-checkpoint](voice-checkpoint.json)
и [alignment-checkpoint](alignment-checkpoint.json) оставлены как история этапов;
старые PASS/RED и числа тестов не являются текущим статусом ветки.

## Границы проверки

`/stop` проходит через настоящее последовательное polling Grammy. Synthetic HOME,
ключи и identity не используют реальные аккаунты. Сбой импорта, timeout harness
или отсутствие запуска CLI — ошибка инфраструктуры, а не допустимый RED поведения.

Тесты не подтверждают баланс/валидность живого Deepgram, качество распознавания,
наличие подписки Claude/Codex и полный паритет старого ядра. Linux-проверка артефакта,
startup после выкладки и реальный Telegram-сценарий — отдельные этапы.
Факт финальной выкладки и живой приёмки фиксируется отдельно для выпущенного
source SHA; этот README сам по себе не подтверждает состояние JAR1.
