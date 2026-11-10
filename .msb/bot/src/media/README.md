# Media / STT

[← Вход ядра](../main.mjs) · [Голос в Telegram ←](../telegram/README.md#голос)

Backend распознавания не отправляет Telegram-сообщения. Он принимает байты,
signal отмены и возвращает полный transcript; download/preview/reply-context
остаются в [telegram/voice.mjs](../telegram/voice.mjs).

| Задача | Функция в [stt.mjs](stt.mjs) | Проверка |
|---|---|---|
| Выбрать provider и env | `resolveSttConfig` | [stt.test.mjs](../../tests/stt.test.mjs) |
| Рассчитать таймаут | `audioTimeoutMs` | [stt.test.mjs](../../tests/stt.test.mjs) |
| Распознать, обработать ошибку/abort | `transcribeVoice` | [stt](../../tests/stt.test.mjs), [voice-lifecycle](../../tests/voice-lifecycle.test.mjs) |

Приоритет настроек: process → per-bot `.env` → shared `<profile.root>/.env`.
Явно пустое значение не заменяется fallback-ключом. Заданный `STT_COMMAND`
приоритетнее Deepgram; он запускается без shell с временным OGG и cleanup.
Deepgram использует `nova-3`, `audio/ogg`, `smart_format`, `punctuate`, язык `ru`
по умолчанию; таймаут 60 с + 30 с/MiB, максимум 300 с.

Отсутствие настройки возвращается как `STT_NOT_CONFIGURED`, чтобы Telegram
показал прежний onboarding. Поздний результат после abort не передаётся модели.
Тесты используют synthetic keys/fake HTTP; качество распознавания настоящего
аудио и живой аккаунт проверяются отдельно. Обработчика содержимого остальных
типов медиа этот модуль не предоставляет.
