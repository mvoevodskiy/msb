# OS-движки

[← Вход ядра](../main.mjs) · [Runtime profile](../../shared/README.md) ·
[CLI-провайдеры](../../../../overlay/bot/ext/README.md)

Этот модуль управляет OS helper. Модель Codex выбирается в overlay; общая
пауза допуска сообщений относится и к выбранному Codex.
Обычный экран «Движки» — [screens/engines](../telegram/screens/engines.mjs);
общая точка маршрута — [handleEnginesRoute](../telegram/routes/engines.mjs).

| Задача | Файл → функция |
|---|---|
| Включить native UI/маршруты по профилю | [shared initialize](../../shared/profile.cjs), затем `MSB_OS_ENGINE=native` |
| Обработать native callback | [telegram.mjs](telegram.mjs): `handleNativeEngineCallback` |
| Показать состояние helper | [screen.mjs](screen.mjs): `nativeEnginesScreen` |
| Прочитать snapshot / запросить свежий status / дождаться результата | [client.mjs](client.mjs): `engineStatusSnapshot`, `refreshEngineStatus`, `waitRequestResult` |
| Подтвердить состояние watcher и служб Пульта | [systemd-status.mjs](systemd-status.mjs), [Pult status](../pult/status.mjs) |
| Опубликовать request без замены чужого slot | [request.mjs](request.mjs): `submitRequest` (совместимый re-export в client) |
| Пауза/пробуждение одного бота и вход очереди | [sleep.mjs](sleep.mjs) → общая [Codex policy](codex-sleep.mjs), [marker](sleep-marker.mjs) / [gate](sleep-gate.mjs) → [bot](../telegram/bot.mjs) / [callback](../telegram/routes/engines.mjs); для остальных провайдеров при сбое локального wake [wake.mjs](wake.mjs) использует существующую системную заявку. Python-запись использует тот же SQLite lock в `usr-local-lib/msb-engine/client_markers.py` |

Профиль `msb` по умолчанию включает native routes; `jar1` сохраняет legacy UI и запрещает
включение native OS-engine через profile initialization. IPC native helper:
`<profile root>/engine/request` → `/run/msb-engine/state.json` (`jar1`: `~/.iia`).
Status read возвращает callback polling сразу; [общая UI-граница](../../shared/callback-renders.mjs)
отменяет obsolete read/retry, но дожидается уже отправленной Telegram доставки.
Ручное обновление не публикует заявку при подтверждённо остановленном watcher.
При активном или неизвестном watcher сохраняется обычная проверка через IPC,
в том числе на холодном старте. Пульт показывает отдельно наблюдаемые службы
и состояние управления из снимка.
Mutation actions не отменяются простой навигацией. `stop` бота дожидается tracked
status/delivery work. [Проверка](../../tests/callback-refresh.test.mjs).
При sleep marker новые сообщения и ожидающие ходы не попадают в модель;
настройки и открытые формы сохраняют доступ. Подготовленный handoff знакомства
остаётся в своём журнале и восстанавливается после пробуждения.
Для Codex сообщение «Codex на паузе» и прежняя кнопка пробуждения не зависят
от статуса другого движка. Маркер остаётся до явного пробуждения или успешного
выбора Claude; при выборе снимается только прежняя ревизия метки. При отказе
локального удаления системная заявка не создаётся. Беседы и настройки CLI
сохраняются. [Проверка выбранного Codex](codex-active.mjs)
использует те же поля provider/engine, что и запуск хода. Допуск очереди считается
активным до проверки паузы, чтобы /stop и shutdown не запустили его позже. Если
пауза возникла во время работающего Codex, /stop и ответ «стоп» проходят к уже
существующему обработчику остановки; метка при этом остаётся до пробуждения.
Текст согласован владельцем 15.11.2026.
[Проверки](../../tests/engine-sleep.test.mjs).
Независимые от провайдера маркер и входной gate проверяют
[sleep-marker](../../tests/sleep-marker.test.mjs), [sleep-gate](../../tests/sleep-gate.test.mjs);
выбранная беседа Codex — [codex-engine-sleep](../../tests/codex-engine-sleep.test.mjs),
очередь и handoff знакомства — [codex-sleep-flow](../../tests/codex-sleep-flow.test.mjs),
кнопки сообщения — [codex-sleep](../../tests/codex-sleep.test.mjs).

Реализация OS-слоя и её границы: [TDR](../../../../docs/tdr/msb-engine-os-replace.md),
[runbook rollback](../../../../docs/runbooks/msb-engine-rollback.md).
Проверки: [engines-client](../../tests/engines-client.test.mjs),
[native-engine-ui](../../tests/native-engine-ui.test.mjs), [runtime-profile](../../tests/runtime-profile.test.mjs).
Native service enable/disable относится к системному OpenClaw другого пользователя.
Runner в [agent/turn.mjs](../agent/turn.mjs) использует отдельный профиль бота;
подтверждение одного маршрута не подтверждает работу другого.
