/** Slash-команды как в закрытом ядре (sBA). */
export const BOT_COMMANDS = [
  { command: 'start', description: 'Меню' },
  { command: 'newtask', description: 'Новая сессия' },
  { command: 'stop', description: 'Остановить задачу' },
  { command: 'compact', description: 'Сжать текущий контекст' },
  { command: 'clear', description: 'Сбросить контекст' },
  { command: 'undo', description: 'Отменить правку' },
  { command: 'projects', description: 'Проекты' },
  { command: 'sessions', description: 'Сессии' },
  { command: 'connect', description: 'VS Code туннель' },
  { command: 'recovery', description: 'Аварийный доступ к серверу' },
  { command: 'settings', description: 'Настройки' },
  { command: 'pult', description: 'Пульт — панель ботов и сервера' },
  { command: 'status', description: 'Статус системы' },
  { command: 'cost', description: 'Расходы за день' },
  { command: 'monitor', description: 'Статус мониторинга' },
  { command: 'digest', description: 'Дайджест контента' },
  { command: 'sources', description: 'Каналы и аккаунты' },
  { command: 'skills', description: 'Навыки агента' },
  { command: 'feedback', description: 'Отзыв' },
  { command: 'claude', description: 'Режим Claude — возможности' },
  { command: 'openclaw', description: 'Режим OpenClaw — возможности' },
  { command: 'help', description: 'Все команды' },
  { command: 'autostatus', description: 'История фоновых прогонов' },
  { command: 'autoactions', description: 'Зарегистрированные действия' },
];

export function commandsForEngine(engine, ccOnly = false) {
  if (ccOnly || engine !== 'oc') {
    return BOT_COMMANDS.filter((c) => c.command !== 'openclaw');
  }
  return BOT_COMMANDS;
}

export const HELP_CC = `<b>Как работать</b>

Пиши задачу текстом — агент сам пишет код, коммитит в git, работает автономно.
Голосовые сообщения работают при настроенном распознавании.
Обработка вложений в open-core пока не подключена.

<b>Управление сессией:</b>
/newtask — новая сессия (сбросить контекст)
/stop — остановить задачу
/clear — новая беседа; файлы и native-история сохраняются
/undo — отменить последнюю правку файла (пока не подключено)

<b>Навигация:</b>
/projects — создание и выбор проекта
/sessions — список сессий

<b>Подключение и доступ:</b>
/pult — панель ботов и сервера (Mini App + ссылка)
/connect — VS Code через туннель (инструкция)
/recovery — аварийный доступ к серверу
/settings — подключения, ключи, SSH, лимиты

<b>Фоновая работа:</b>
/autostatus — история фоновых прогонов
/autoactions — что зарегистрировано и когда сработает

<b>Мониторинг:</b>
/monitor — статус мониторинга
/digest — дайджест контента
/sources — каналы и аккаунты

<b>Информация:</b>
/status — текущий проект и рабочая директория
/cost — сохранённые данные расходов
/skills — навыки агента
/feedback — отправить отзыв`;

export const HELP_OC = `<b>Как работать</b>

Пиши задачу текстом — агент сам пишет код, коммитит в git, работает автономно.
Обработка голосовых и вложений в open-core пока не подключена.

<b>Управление сессией:</b>
/newtask — новая сессия (сбросить контекст)
/stop — остановить задачу
/clear — новая беседа; файлы и native-история сохраняются
/undo — отменить последнюю правку файла (пока не подключено)

<b>Возможности движка (OpenClaw):</b>
/context — что сейчас в контексте сессии
/tools — что агент умеет прямо сейчас
/commands — все команды движка

<b>Навигация:</b>
/projects — создание и выбор проекта
/sessions — текущая сессия

<b>Подключение и доступ:</b>
/pult — панель ботов и сервера (Mini App + ссылка)
/connect — VS Code через туннель (инструкция)
/recovery — аварийный доступ к серверу
/settings — подключения, ключи, SSH, лимиты

<b>Фоновая работа:</b>
/autostatus — история фоновых прогонов
/autoactions — что зарегистрировано и когда сработает

<b>Мониторинг:</b>
/monitor — статус мониторинга
/digest — дайджест контента
/sources — каналы и аккаунты

<b>Информация:</b>
/status — текущий проект и рабочая директория
/cost — сохранённые данные расходов
/skills — навыки агента
/feedback — отправить отзыв`;

export const CC_ONLY_OC_BLOCK = `Этот бот работает только с 👾 Claude Code.
OpenClaw ставится отдельно: /settings → ⚙️ Движки → ➕ OpenClaw.`;
