# OS-движки

[← Вход ядра](../main.mjs) · [Runtime profile](../../shared/README.md) ·
[CLI-провайдеры](../../../../overlay/bot/ext/README.md)

Этот модуль управляет OS helper. Codex выбирается в overlay и сюда не направляется.
Обычный экран «Движки» — [screens/engines](../telegram/screens/engines.mjs);
общая точка маршрута — [handleEnginesRoute](../telegram/routes/engines.mjs).

| Задача | Файл → функция |
|---|---|
| Включить native UI/маршруты по профилю | [shared initialize](../../shared/profile.cjs), затем `MSB_OS_ENGINE=native` |
| Обработать native callback | [telegram.mjs](telegram.mjs): `handleNativeEngineCallback` |
| Показать состояние helper | [screen.mjs](screen.mjs): `nativeEnginesScreen` |
| Прочитать snapshot / запросить свежий status / дождаться результата | [client.mjs](client.mjs): `engineStatusSnapshot`, `refreshEngineStatus`, `waitRequestResult` |
| Опубликовать request без замены чужого slot | [request.mjs](request.mjs): `submitRequest` (совместимый re-export в client) |
| Пауза выбранного Codex | [sleep](sleep.mjs) → [marker](sleep-marker.mjs) / [gate](sleep-gate.mjs) → [bot](../telegram/bot.mjs) / [wake](../telegram/routes/engines.mjs) |

На этом выпуске sleep-маркер блокирует только выбранный Codex. Сообщение
«Codex на паузе» и прежняя кнопка пробуждения не зависят от другого движка;
маркер сохраняется до явного пробуждения. Ошибка локального удаления не создаёт
системную заявку. Другие провайдеры остаются на ранее установленном маршруте.
Очередь, знакомство, /stop и взаимодействие маркера с writer проверяются в
[codex-sleep-flow](../../tests/codex-sleep-flow.test.mjs),
[codex-engine-sleep](../../tests/codex-engine-sleep.test.mjs),
[sleep-marker](../../tests/sleep-marker.test.mjs) и [sleep-gate](../../tests/sleep-gate.test.mjs).

Профиль `msb` по умолчанию включает native routes; `jar1` сохраняет legacy UI и запрещает
включение native OS-engine через profile initialization. IPC native helper:
`<profile root>/engine/request` → `/run/msb-engine/state.json` (`jar1`: `~/.iia`).
Status read возвращает callback polling сразу; [общая UI-граница](../../shared/callback-renders.mjs)
отменяет obsolete read/retry, но дожидается уже отправленной Telegram доставки.
Mutation actions не отменяются простой навигацией. `stop` бота дожидается tracked
status/delivery work. [Проверка](../../tests/callback-refresh.test.mjs).

Реализация OS-слоя и её границы: [TDR](../../../../docs/tdr/msb-engine-os-replace.md),
[runbook rollback](../../../../docs/runbooks/msb-engine-rollback.md).
Проверки: [engines-client](../../tests/engines-client.test.mjs),
[native-engine-ui](../../tests/native-engine-ui.test.mjs), [runtime-profile](../../tests/runtime-profile.test.mjs).
Native service enable/disable не означает наличие OpenClaw runner в общем ходе;
его ветвь в [agent/turn.mjs](../agent/turn.mjs) пока возвращает ошибку подключения.
