# Проекты: папка, контекст и новая беседа

[Вход ядра](../main.mjs) · [Telegram](../telegram/README.md) · [Runner](../agent/README.md)

Это восстановление старого `/projects`, `/project` и меню в новом open-core.
[Точный old-контракт и provenance](../../tests/reference/parity-projects-contract.txt)
закрепляют тексты, нормализацию и переходы; старый bundle в runtime не переносится.

Стабильный base workspace задаётся общим [paths](../paths.mjs). Projects-root —
`dirname(base)/projects`. [Project paths](paths.mjs) проверяет single-segment имя,
существование каталога и containment до записи/выбора. Выбранная папка не меняет
глобальные auth/env/state пути. [Files](files.mjs) читает список и создаёт прежние
memory/knowledge; Git init ограничен по времени и best-effort, без обещания repo health.
Существующий `.git` не переинициализируется. Нет shell interpolation или записи
через существующий project symlink вне root.

[Selection](selection.mjs) — единственный переход activeProject/default:
одна транзакция очищает ccSessionId, lastCcUsage, parkedCcSessions и все
pendingCcSessionStarts, увеличивает sessionEpoch. Модели, провайдеры, auth и native
истории не удаляются. Callback, команда и форма используют этот переход. Текущий
ход сохраняет ранее captured cwd; следующий работает в новой папке. Старый first
result не может восстановить ID из другой папки или стереть новую резервацию.

[Context](context.mjs) добавляет `.current-task.md`, memory за день сохранённого
часового пояса и `knowledge/_index.md` из captured cwd. Базовые owner files остаются
в [system prompt](../agent/system-prompt.mjs). Optional ошибки не блокируют ход;
роль-маркеры удаляются, текст каждого файла ограничен, ссылки вне cwd пропускаются.
Это не гарантия native project-instruction загрузки Claude/Codex или полноты всех
старых глобальных context sources; особенности native CLI проверяются отдельно.

[Restore](restore.mjs) вызывается до polling. Валидный saved project не переписывает
state/session. Подтверждённый missing возвращает base с fresh conversation;
ошибка доступа сохраняет выбор для retry. Создаётся project-root CLAUDE symlink,
но существующие пользовательские файлы/ссылки не перезаписываются. Старое опасное
удаление regular CLAUDE.md не переносится. Неизвестное происхождение native ID из
раннего cwd stub не служит основанием массового reset.

Проверки: [UI/files/state](../../tests/projects.test.mjs),
[реальный runner с fake native child](../../tests/project-execution.test.mjs),
[overlap/provider races](../../tests/project-races.test.mjs),
[startup](../../tests/project-restore.test.mjs),
[границы optional context](../../tests/project-context.test.mjs).
Изолированные тесты не объявляют живую интеграцию CLI/Telegram проверенной.
Code-only rollback возвращает код, но не удаляет созданные папки/Git и не возвращает
сброшенные conversation pointers; сами native истории остаются.
