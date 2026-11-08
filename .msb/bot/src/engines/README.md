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
| Прочитать status / записать request / дождаться результата | [client.mjs](client.mjs): `engineStatusSnapshot`, `submitRequest`, `waitRequestResult` |

Профиль `msb` по умолчанию включает native routes; `jar1` сохраняет legacy UI и запрещает
включение native OS-engine через profile initialization. IPC native helper:
`~/.msb/engine/request` → `/run/msb-engine/state.json`.

Реализация OS-слоя и её границы: [TDR](../../../../docs/tdr/msb-engine-os-replace.md),
[runbook rollback](../../../../docs/runbooks/msb-engine-rollback.md).
Проверки: [engines-client](../../tests/engines-client.test.mjs),
[native-engine-ui](../../tests/native-engine-ui.test.mjs), [runtime-profile](../../tests/runtime-profile.test.mjs).
Native service enable/disable не означает наличие OpenClaw runner в общем ходе;
его ветвь в [agent/turn.mjs](../agent/turn.mjs) пока возвращает ошибку подключения.
