# Беседы: журнал бота и явный выбор

[Runner](../agent/README.md) · [Telegram](../telegram/README.md) ·
[Old-контракт](../../tests/reference/parity-sessions-contract.txt)

`state.sessionHistory` хранит прежние описания/ID, а не native transcripts.
[Ledger](ledger.mjs) обновляется только внутри [result transaction](../agent/session-result.mjs)
после подтверждения ownership. First/last descriptions до200символов используют
общую прежнюю [redaction](../history/preview.mjs); limit100 не удаляет native файлы.
Count означает вернувшиеся engine passes, включая разрешённые known-ID failed/
aborted attempts, не только доставленные успешные ответы. Boot/чтение списка
ничего не импортируют и не фабрикуют для старого native ID без описания.

[Scope](scope.mjs) выводит только однозначные строки текущего CLI-провайдера:
legacy provider узнаётся по ID, declared provider не может противоречить ему.
Модели/auth/store.sessions не служат источником выбора. Force-Claude conflict
с core Codex snapshot не предлагает чужой ID и не переключает провайдера скрыто.
OC native list/reattach/restoreprev требует своего отсутствующего backend;
существующий OC view остаётся прежним, этот этап не объявляет его восстановленным.

[Selector](selection.mjs) валидирует directory, затем снова проверяет row/provider/
project/epoch внутри одной state transaction. В том же проекте чужие slots и
first tokens сохраняются, selected slot/token очищается. В другом проекте
[project selection](../projects/selection.mjs) очищает все old-cwd reservations,
после чего target ID ставится в той же транзакции. Usage не переносится от другой
беседы. Reset оставляет ledger/native файлы; явный выбор после reset разрешён.
Неизвестный/foreign/stale/ambiguous callback не пишет state или pending forms.

[Callback key](callback-key.mjs) использует общий bounded stateless codec;
короткие старые session:ID остаются прежними. [Telegram route](../telegram/routes/sessions.mjs)
и [list renderer](../telegram/screens/session-list.mjs) сохраняют прежние pages10,
number buttons5/row, markers, continuation, Back и тексты reset. List/page/select
не закрывают формы ввода — это старый контракт. Доставка идёт по существующим
callback scopes/lane, с прежним отключением URL previews, без второго transport.

[UI/selection checks](../../tests/sessions.test.mjs),
[runner metadata](../../tests/session-ledger.test.mjs),
[existing ownership](../../tests/first-session.test.mjs).
Фактическое продолжение выбранной беседы через runner/CLI и overlap-races требуют
отдельной проверки; одни поля ID/project или зелёный экран её не заменяют.
Полный same-commit Linux gate и разрешённая живая приёмка обязательны перед выпуском.
Code-only rollback не удаляет новые описания/native файлы и не возвращает указатели
сессий/проектов из старого профиля. Не восстанавливать auth/env целиком ради кода.


Размер страницы: [text formatter](../telegram/screens/session-list-text.mjs) считает
видимый UTF16 до HTML escaping. Только при превышении4096 сокращаются подписи;
все10 строк/ID actions/markers остаются, обычный вид не меняется. Общий
[clip](../history/clip.mjs) удерживает границы Unicode в stored200 и UI previews;
native IDs/ledger descriptions не перезаписываются ради display budget.
[Size/Unicode checks](../../tests/session-list-size.test.mjs) включают exact normal
layout и неизменность metadata после отображения. Метаданные не удаляются ради
уменьшения длины Telegram сообщения.
