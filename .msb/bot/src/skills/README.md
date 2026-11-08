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
