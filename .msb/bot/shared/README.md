# Общий runtime profile

[← Вход ядра](../src/main.mjs) · [Core](../OPEN-CORE.md) ·
[Overlay](../../../overlay/bot/ext/README.md) · [Выпуск](../../../tools/release/README.md)

[profile.cjs](profile.cjs) — единственный resolver для ядра, overlay и entrypoints.
В исходниках `overlay/bot/shared` — ссылка на этот каталог; release кладёт одну
копию в `bot/shared`. Native auth paths профиль не переносит.

| Профиль | Root по умолчанию | Env / Codex HTTP ID | OS-engine |
|---|---|---|---|
| `msb` | `~/.msb` | `MSB_*` / `msb_http` | `native` |
| `jar1` | `~/.iia` | совместимость `IIA_*` / `iia_http` | `legacy` |

`resolveProfile`: явный `MSB_RUNTIME_PROFILE` → наличие `MSB_BOT_ID` → наличие
`IIA_BOT_ID` → `runtime-profile.json` выпуска → `msb` при отсутствии файла.
Неизвестный профиль — ошибка. Root можно задать через `MSB_RUNTIME_ROOT`/alias;
HOME, bot ID и root разрешаются при вызове, default выпуска читается при импорте.

[preload.mjs](preload.mjs) вызывает `initialize` до импорта потребителей:
добавляет отсутствующие `MSB_*` aliases для `IIA_*` и default `MSB_OS_ENGINE`.
Явный `MSB_*`, включая пустое значение, имеет приоритет. `setEnvValue` обновляет
созданные этим resolver aliases, не подменяя явно заданные значения.
Для `jar1` попытка native OS-engine отклоняется.

| Потребитель | Следующий файл |
|---|---|
| Core paths / env | [src/paths.mjs](../src/paths.mjs), [env/store](../src/env/store.mjs) |
| Overlay paths / auth env | [ext/paths](../../../overlay/bot/ext/paths.mjs), [ext/env](../../../overlay/bot/ext/env.mjs) |
| Защита от legacy vendor updater | `shouldSkipVendorUpdate` → [puller](../../puller.cjs), [sync](../../sync.cjs) |
| Профиль экспортированного runtime | [release profile](../../../tools/release/profiles/jar1.json), [profile-smoke](../../../tools/release/profile-smoke.mjs) |

Проверки: [runtime-profile](../tests/runtime-profile.test.mjs),
[profile-ui](../tests/profile-ui.test.mjs). Это совместимость путей одного кода,
а не миграция данных, auth или сервисов между `.msb` и `.iia`.

## Первый session ID

[session-starts.mjs](session-starts.mjs) — чистые операции резервации первого
CLI-хода для core и overlay. `pendingCcSessionStarts` — внутренний per-provider
token, не history metadata или авторизация. Переключение сохраняет token;
`/newtask`, `/clear` и существующие reset-действия отменяют только текущий.
Поздний успешный ID допускается только для своего token/provider и пустого
слота; обычный fence существующих IDs не ослабляется. Маршрут и тесты —
[исполнение](../src/agent/README.md#общий-ход).


[Claude catalog](claude-models.mjs) — общие old model identities для core и
защиты provider boundaries; policy находится в agent/models, а не в UI renderer.
[Native resolver](claude-binary.mjs) используется startup/shim и metadata reader,
исключает собственный shim по realpath. Это чтение локальной CLI версии, без auth
или provider turn. [Native checks](../tests/claude-version.test.mjs).

[env-writes.mjs](env-writes.mjs) — единая process queue для core и provider
read/modify/write env; scope/валидация остаются у вызывающих. Обе стороны
импортируют одну копию shared. [Контракт](../tests/reference/parity-env-write-contract.txt),
[проверки порядка/ошибок](../tests/env-write-order.test.mjs).


[engine-policy.mjs](engine-policy.mjs) сохраняет old OA/vB/RW: наличие legacy OC
state делает Claude-only preference неэффективным; [loadState](../src/state.mjs)
запоминает обнаружение на время процесса отдельно для каждого bot profile. На диск
новых полей не пишется. MSB_CC_ONLY — действующий canonical alias, JARVIS_CC_ONLY
совместим. [Skill target](../src/skills/install-target.mjs) захватывает эту eligibility
вместе с provider/home. Это не включение OS engine/helper и не разрешение native
Codex через существующий отдельный guard. [Проверки](../tests/skills-install-policy.test.mjs).
