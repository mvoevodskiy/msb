# JAR1 · исправления Telegram UX

Пакет для `VM-422100`, `/home/client/.msb/bot` и `msb-bot@default.service`.
[Предыдущий выпуск](../jar1-attachment-delivery/ACCEPTANCE.md) задаёт исходный
inventory. В Git-кандидат перенесены десять исправлений с рабочей ветки. При
разрешении конфликтов сохранены провайдеры и маршруты принятого выпуска.

`build.py --repo REPO --commit SHA --stage LOCAL_STAGE --prior-manifest PRIOR`
проверяет SHA предыдущего manifest, исходные Git blobs и полный список
изменившихся runtime-файлов. Пакет содержит Git snapshot, выборочный payload и
операторы того же коммита. Новый модуль уведомлений лежит в существующем
каталоге `src`, чтобы откат добавленного файла не менял дерево каталогов.

На сервере используй новый root-owned stage прямо под `/var/tmp`. Сверь SHA
архива перед распаковкой. Добавь только две ссылки на установленные зависимости
по [правилам предыдущего выпуска](../jar1-attachment-delivery/README.md), затем
запусти `python3 -I -B STAGE/launcher.py --stage STAGE --manifest-sha MANIFEST_SHA`.
Launcher проверяет пакет под `client` с изолированными HOME, PID и сетью.
В proof входят ядро, overlay, эталонные сценарии, локальный нативный Codex steer
и тесты оператора.

Сверь план командой `python3 -I -B STAGE/deploy.py --stage STAGE --backup BACKUP
--manifest-sha MANIFEST_SHA --report-sha PROOF_SHA`. Перед применением проверь
тишину в Telegram. К той же команде добавь `--apply --queue-confirmed`.
`BACKUP` — новый каталог прямо под `/var/lib/msb-ops/releases`.

Транзакция использует прежние проверки inventory, профиля, Node, CLI и
системного запроса. Она останавливает только целевого бота и проверяет polling.
Живую приёмку меню и рабочего хода проведи отдельно. Откат после проверки
тишины использует тот же stage, backup и proof с `--rollback --queue-confirmed`.
