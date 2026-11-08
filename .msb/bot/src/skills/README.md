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
