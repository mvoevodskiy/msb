# Локальные пакеты (`local/ext`)

[← Обвязка](../README.md) · [Загрузчик](../local-ext.mjs) ·
[Политика обновлений](../../../../bootstrap/UPDATE-POLICY.md)

Место для **локальных доработок владельца сервера**, которое релиз и `applyExt`
не затирают. Несовместимость с новым API допустима: пакет пропускается, бот
стартует. Цель — не править файлы релиза после каждого обновления.

## Куда класть

Каталог относительно корня профиля (`~/.msb` или `~/.iia`):

```text
<root>/local/ext/<id>/
  manifest.json
  prepare.mjs      # опционально
  callback.mjs     # опционально
```

Пример для MSB: `~/.msb/local/ext/my-hooks/`.

Нет каталога или пакетов → no-op, поведение как у чистого релиза.

## `manifest.json`

```json
{
  "id": "my-hooks",
  "version": "1.0.0",
  "msbApi": 1,
  "order": 100,
  "onPrepare": "./prepare.mjs",
  "onCallback": "./callback.mjs"
}
```

| Поле | Обязательно | Смысл |
|---|---|---|
| `id` | да | Совпадает с именем каталога; `[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}` |
| `version` | нет | Строка версии пакета (для логов) |
| `msbApi` | да | Минимальная версия контракта; если `>` контракта обвязки — **skip** |
| `order` | нет | Порядок загрузки (меньше раньше); иначе по `id` |
| `onPrepare` | нет | Модуль точки входа prepare |
| `onCallback` | нет | Модуль точки входа callback |
| `onMessage` | нет | Зарезервировано; в v1 не вызывается |

Контракт обвязки сейчас: **`msbApi` = 1** (`MSB_LOCAL_API` в загрузчике).

## Точки входа

Модуль экспортирует функцию с именем хука или `default`:

```js
// prepare.mjs
export default async function onPrepare({ id, apiVersion, log }) {
  log('ready');
}

// callback.mjs — вернуть true, чтобы поглотить callback (не отдавать ядру)
export default async function onCallback({ data, bot, cq, log }) {
  if (data !== 'local:ping') return false;
  await bot.api.answerCallbackQuery(cq.id).catch(() => {});
  log('ping');
  return true;
}
```

Порядок: `onPrepare` при старте (`prepare` обвязки); `onCallback` после
штатных веток overlay, до passthrough в ядро. Ошибка одного пакета → строка в
лог, остальные и ядро продолжают.

При загрузке в stderr: `local: N ok / M skip` (и `/ E error`, если были сбои).

## Чего не делать

- Править файлы релиза (`bot/**`, `bot/ext/**` и т.п.) «поверх» обновления —
  неподдерживаемый путь; канон — пакеты в `local/ext/`.
- Класть секреты и предметную логику продукта в upstream / манифест релиза.
- Ожидать вечную ABI-совместимость: при росте `MSB_LOCAL_API` старый пакет с
  завышенным `msbApi` будет пропущен до правки владельцем.
- Считать `local/` частью маркетплейса или UI установки (вне скоупа v1).

## Правила релиза / applyExt

- Никогда не писать и не удалять содержимое `<root>/local/`.
- Файлы вне списка релиза в зоне `local/` не считаются «лишними».
- Путь манифеста выкладки, начинающийся с `local/`, отклоняется.

Проверка: [local-ext.test.mjs](../tests/local-ext.test.mjs).
