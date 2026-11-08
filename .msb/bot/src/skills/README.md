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
prompt/marker/write/final-response связан ниже; native/live приёмка ещё обязательна.
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
[production UI](../../tests/skills-openclaw.test.mjs). Длинный список доставляет
[общий view transport](../telegram/view-delivery.mjs): все записи, balanced HTML,
короткие имена в одном code span, Back только на последней части. Обычный список
сохраняется byte-exact, дополнительных кнопок/пагинации/footer нет.
OC brain/live/full release остаются непроверенными.


## INSTALL_SKILL: прежний model marker

[Runner](../agent/turn.mjs) добавляет [инструкцию/формат](install-protocol.mjs) и
возвращает [captured target](install-target.mjs). [Processor](response-markers.mjs)
вызывается только на возвращённом model final text в Telegram, перед plan,
доставкой и журналом. Read-only screens не исполняют markers. Complete firstblock
парсится со старыми пределами; остальные complete blocks убираются. Flag0 strip,
incomplete marker literal, старые invalid/failure/success тексты сохранены.
Успех подставляется только после реальной записи. Infrastructure exception и abort
не запускают writer; returned CC partial text допускается, OC partial error — нет.

[Writer](install-writer.mjs) пишет user-global native skill: Claude прежний
HOME/.claude/skills, Codex собственный HOME/.agents/skills. Add project advice
не меняет writer scope. Claude/OC используют прежнее условное зеркало в уже
существующем HOME/.openclaw; Codex его не создаёт. Старый OA/vB/RW учитывает
[наблюдённый OC state](../../shared/engine-policy.mjs), не только bool flag.
Unknown provider не получает чужую папку или выдуманный результат. Ни native auth,
ни config/profile не мигрируются, MCP marker/backend сюда не добавлен.

Предыдущие bytes сначала публикуются в .bak через свой exclusive temp; только
потом аналогично заменяется SKILL.md. Ошибка backup сохраняет старый файл.
Publication заменяет link entry, не внешний target; symlink самого native-root
поддержан, выход дочерней skill directory наружу отклонён. Aliasing roots пишутся
один раз физически, сохраняя old two-engine result. Собственные temps чистятся;
existing mode сохраняется. Нет гарантии atomic containment против concurrent
parent replacement, общей primary/mirror транзакции или concurrent install lock.
Сигнал проверяется до/между мутациями, уже принятая filesystem operation дренируется.
Ошибка metadata необязательного OC home пропускает только зеркало, как old exists.

[62 installer cases](../../tests/skills-install.test.mjs),
[filesystem](../../tests/skills-install-files.test.mjs), [policy](../../tests/skills-install-policy.test.mjs).
Два из cases проводят весь actual bot→runner→protocol double→writer→response/journal;
это не native CLI/model proof. Native0.166 discovery/parsed frontmatter, provider
application и target/live приёмка перед выпуском остаются отдельным gate. Полные
skill bodies из unproven cp/nHA в prompt не внедряются, фоновые записи не расширены.


Native0.166 gate обнаружил настоящий syntax-defect: legacy quote-only formatter
создавал invalid YAML для backslash/NUL description, хотя file-write tests были
зелёными. Описание теперь сериализуется как JSON-compatible YAML quoted scalar,
с escaping C1/noncharacters и прежней UTF8 replacement нормализацией. Обычные
plain/quoted descriptions byte-exact, validation limits/body/name не меняются.
[Native RED proof](../../tests/reference/skills-native-install-0.166-red.json).
[Manual native smoke](../../tests/fixtures/skills-native-install.mjs) принимает
absolute binary и SOURCE_SHA, создаёт свой HOME/CODEX_HOME, пишет только synthetic
skills и запрашивает initialize/skills/list. Login/model не вызывает; сетевую
изоляцию задаёт caller. Это не owner skill installation или model application.
