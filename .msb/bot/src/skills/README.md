# Навыки: каталог и прежние экраны

[Telegram routes](../telegram/routes/skills.mjs) → [catalog](catalog.mjs) →
[Claude reader](claude-catalog.mjs) либо native provider extension →
[views](../telegram/screens/skills.mjs). [Old contract](../../tests/reference/parity-skills-contract.txt).

Чтение не меняет state, авторизацию, provider, настройки или SKILL.md. Claude
сканирует прежние HOME/base/project roots, используя старый простой frontmatter
parser. Ошибки каталога/metadata пропускаются; содержимое открывается заново.
Имя system скрывает только список, disabled остаётся видимым. Native provider
вызывается отдельно через bot `msb.skillsProvider(snapshot,{env,cwd,workspace,signal})`;
его контракт — `{ok,entries}` с name/description/fullPath/path/source/size/disabled/
providerId. Codex не получает чужой Claude каталог при недоступном native reader.

Codex metadata приходит через [overlay reader](../../../../overlay/bot/ext/codex-skills.mjs)
и его [stdio transport](../../../../overlay/bot/ext/codex-skills-rpc.mjs), только
initialize/initialized/skills-list для captured cwd. Native enabled/scope и stat
настоящего файла дают карточку; не требуется login или model turn ради списка.
Неверный cwd/schema/CLI failure не подменяется пустым или Claude каталогом.
Недоступный после scan файл пропускается; native parse errors не выводятся,
поэтому список не доказывает полноту всех файлов на диске. Native app-server
может иметь внутренние эффекты; перечень наших read RPC их отсутствие не доказывает.

Native repo scope в base доступен в текущем workspace; для него эта подпись
уточняется, сохраняя старые папки/кнопки. Global user/system/admin сохраняют
прежнее «в любом проекте». Для Claude прежние тексты остаются без изменений.
Команда /skills и read callbacks освобождают polling handler, имеют общий
[реальный message/callback lifecycle](../../shared/callback-renders.mjs), отменяются
на navigation/stop/shutdown и дожидаются закрытия native процесса.

[Reference](reference.mjs) привязывает все новые callbacks к provider/root/source/path
через общий stateless codec, включая короткие workspace paths. Иначе удалённый
base-файл мог бы незаметно замениться одноимённым HOME-файлом при открытии старой
кнопки. Исторический literal разрешается только в одну известную Claude строку;
исходный root/project старого не scoped path восстановить невозможно. Новые
root-bound ссылки этой неоднозначности не имеют. Файлы не мигрируются ради UI.

[Read tests](../../tests/skills-read.test.mjs) проходят production bot/route, а
[native tests](../../tests/skills-native.test.mjs) используют настоящий overlay и
подменённый локальный CLI. Одна Add-подсказка не доказывает установку: installer
prompt/marker/write/final-response — отдельный обязательный этап перед приёмкой.
Exported old cp/nHA не доказаны как direct native CC prompt; blanket injection
полных body не добавлять. Полнота native providers/OC и live проверяется отдельно.

## OpenClaw: прежний отдельный список

[Reader](openclaw.mjs) запускает только `openclaw skills list --json --eligible`,
наследуя cwd процесса, как старый rw. Child env копируется с прежним HB-фильтром;
родительские ключи не меняются. `createBot` позволяет внедрить reader для тестов;
по умолчанию он native, а обычные fixtures используют unavailable-result, чтобы
не вызвать установленный на компьютере OpenClaw. Авторизация/сервис не настраиваются.

[Read presentation](../telegram/skills-read.mjs) разделяется командой/callback:
OC typing best effort, loading edit без fallback, итог через прежний show/reply.
[Grouped formatter](../telegram/screens/openclaw-skills.mjs) сохраняет старые
JSON-envelope приоритеты, группы/сортировку/Back, empty против all-system и учёт
userInvocable false. Карточки/Add относятся к CLI; stale действия под OC не
открывают чужие файлы. Новых кнопок нет. HTML полей экранируется, description
сохраняет old encoded90 budget без обрыва entity/surrogate.

Native IO ограничен 12s/4MiB; close обычно ожидается. После observed leader exit
групповые сигналы прекращаются; конечный grace освобождает только наши потоки и
observer handle с failure. Это не гарантия reap неизвестных/escaped descendants
или атомарного контроля OS PGID. Native CLI internal side effects этим не доказаны.
[Process tests](../../tests/openclaw-skills-reader.test.mjs),
[production UI](../../tests/skills-openclaw.test.mjs). Доставка oversized списка
пока отдельный RED; installer/OC brain/live/full release остаются непроверенными.
