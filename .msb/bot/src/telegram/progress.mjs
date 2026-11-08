import { presentationSignal } from './presentation-api.mjs';

/** Legacy OS thinking/typing presentation, independent of buffered CLI events. */
const PREPARING = [['Думаю…', '⏳'], ['Думаю…', '⌛️'], ['Вникаю…', '👁️'], ['Мозгую…', '🧠'], ['Соображаю…', '🤔'], ['Анализирую…', '📡'], ['Формулирую…', '🧐']];
const FRAMES = [['Думаю…', '⏳'], ['Думаю…', '⌛️'], ['Соображаю…', '🤔'], ['Мозгую…', '🧠'], ['Формулирую…', '🧐']];
// Original tool labels (vendor B4A).
const TOOL_LABELS = {
  read_file: ["👁️", "Читаю файл"],
  write_file: ["✏️", "Пишу файл"],
  edit_file: ["🔧", "Редактирую файл"],
  search_files: ["🔍", "Ищу в файлах"],
  list_files: ["📂", "Смотрю файлы"],
  shell: ["💻", "Выполняю команду"],
  git: ["🔀", "Git"],
  web_search: ["🌐", "Ищу в интернете"],
  web_fetch: ["🌐", "Загружаю страницу"],
  http_request: ["🌐", "HTTP запрос"],
  browse: ["🌐", "Открываю браузер"],
  save_note: ["📝", "Записываю"],
  update_memory: ["🧠", "Обновляю память"],
  search_memory: ["🔍", "Ищу в памяти"],
  kb_save: ["📚", "Сохраняю в базу"],
  kb_read: ["📚", "Читаю из базы"],
  kb_list: ["📚", "Смотрю базу"],
  vector_search: ["🔍", "Семантический поиск"],
  add_source: ["📡", "Добавляю источник"],
  monitor_search: ["📡", "Ищу в мониторинге"],
  monitor_latest: ["📡", "Свежий контент"],
  monitor_stats: ["📡", "Статистика"],
  monitor_configure: ["📡", "Настраиваю мониторинг"],
  trigger_poll: ["📡", "Опрашиваю источник"],
  task_create: ["📋", "Создаю задачу"],
  task_list: ["📋", "Смотрю задачи"],
  task_update: ["📋", "Обновляю задачу"],
  task_complete: ["📋", "Завершаю задачу"],
  background_task: ["⚙️", "Фоновая задача"],
  task_status: ["⚙️", "Статус задачи"],
  send_buttons: ["⌨️", "Готовлю кнопки"],
  send_media: ["📎", "Готовлю файл"],
  check_capabilities: ["🔑", "Проверяю настройки"],
  Read: ["👁️", "Читаю файл"],
  Write: ["🖊️", "Пишу файл"],
  Edit: ["🔧", "Редактирую"],
  MultiEdit: ["🔧", "Правлю файлы"],
  Bash: ["💻", "Работаю с терминалом"],
  Glob: ["📂", "Ищу файлы"],
  Grep: ["🔍", "Ищу в коде"],
  WebFetch: ["🌐", "Открываю страницу"],
  WebSearch: ["🌐", "Ищу в интернете"],
  TodoWrite: ["📋", "Обновляю задачи"],
  TodoRead: ["📋", "Читаю задачи"],
  NotebookRead: ["📊", "Читаю данные"],
  NotebookEdit: ["📊", "Правлю данные"],
  Task: ["🤖", "Запускаю агента"],
  execute: ["💻", "Выполняю команду"],
  read: ["👁️", "Читаю файл"],
  edit: ["🔧", "Редактирую"],
  search: ["🔍", "Ищу"],
  fetch: ["🌐", "Загружаю страницу"],
  think: ["🧠", "Думаю"],
  delete: ["🗑️", "Удаляю"],
  move: ["📦", "Перемещаю"],
  ToolSearch: ["🧰", "Подбираю инструмент"],
  Agent: ["🤖", "Запускаю агента"],
  Skill: ["📗", "Открываю навык"],
  SendMessage: ["✉️", "Пишу агенту"],
  ListAgents: ["🤖", "Смотрю агентов"],
  Workflow: ["🤖", "Запускаю помощников"],
  Monitor: ["👀", "Слежу за командой"],
  BackgroundWait: ["⏳", "Работаю в фоне"]
};

export function startTurnProgress(ctx, messageId, { signal, preparing = false, now = () => performance.now(), timers = globalThis } = {}) {
  let start = now();
  const thread = (ctx.message || ctx.callbackQuery?.message)?.message_thread_id;
  const topic = thread && thread !== 1 ? { message_thread_id: thread } : {};
  const typingAbort = new AbortController();
  const editsAbort = new AbortController();
  presentationSignal(typingAbort.signal);
  presentationSignal(editsAbort.signal);
  let pausedUntil = 0;
  const pauseOnRateLimit = err => {
    const seconds = err?.parameters?.retry_after;
    if (err?.error_code === 429 && Number.isFinite(seconds) && seconds > 0) {
      pausedUntil = Math.max(pausedUntil, now() + seconds * 1000);
    }
  };
  let stopped = false, frame = 0, lastEdit = -Infinity, lastText = '', tool = null;
  let pending = null, editing = false, edits = Promise.resolve(), typingPending = Promise.resolve(), typingBusy = false;
  let animationTimer, typingTimer, initialTimer;
  const enqueue = text => {
    if (stopped || text === lastText) return;
    lastText = text; pending = text;
    if (editing) return;
    editing = true;
    edits = (async () => {
      while (!stopped && pending !== null && now() >= pausedUntil) {
        const value = pending; pending = null;
        // Do not abort an accepted edit on stop: Telegram may still apply it
        // after a cancelled client fetch, overwriting the terminal status.
        const requestSignal = presentationSignal(AbortSignal.any([editsAbort.signal, AbortSignal.timeout(15_000)]));
        try { await ctx.api.editMessageText(ctx.chat.id, messageId, value, {}, requestSignal); } catch (err) { pauseOnRateLimit(err); }
      }
    })().finally(() => { editing = false; });
  };
  const tick = () => {
    if (stopped || signal?.aborted || now() < pausedUntil) return;
    const elapsed = Math.max(0, now() - start);
    const interval = elapsed >= 900000 ? 30000 : elapsed >= 300000 ? 10000 : 2000;
    if ((!preparing || interval > 2000) && now() - lastEdit < interval - 250) return;
    const suffix = elapsed >= 300000 ? ` ${Math.floor(elapsed / 60000)} мин` : elapsed >= 2000 ? ` ${Math.floor(elapsed / 1000)}с` : '';
    let text;
    if (tool) {
      const name = String(tool.name || '').replace(/^mcp__(.+?)__/, '');
      const [emoji, label] = TOOL_LABELS[tool.name] || TOOL_LABELS[name] || ['⚙️', /^[\w.:-]{1,24}$/.test(name) ? name : 'Работаю'];
      const input = tool.rawInput || (typeof tool.input === 'object' ? tool.input : { command: tool.input || '' });
      const detail = formatToolInput(tool.name, input) || formatToolInput(name, input);
      text = `${label} ${emoji}${detail ? ` · ${detail}` : ''}${suffix}`;
    } else {
      const index = !preparing && elapsed >= 300000 ? Math.floor(elapsed / 10000) : frame;
      const frames = preparing ? PREPARING : FRAMES;
      const [label, emoji] = frames[index % frames.length];
      text = `${label}${preparing ? '' : ' '}${emoji}${suffix}`;
    }
    lastEdit = now(); enqueue(text);
  };
  const typing = () => {
    if (stopped || typingBusy || now() < pausedUntil) return;
    typingBusy = true;
    typingPending = Promise.resolve().then(() => {
      if (!stopped) return ctx.api.sendChatAction(ctx.chat.id, 'typing', topic, typingAbort.signal);
    }).catch(pauseOnRateLimit).finally(() => { typingBusy = false; });
  };
  const stop = () => {
    stopped = true; pending = null;
    timers.clearInterval(animationTimer); timers.clearInterval(typingTimer);
    if (initialTimer !== undefined) timers.clearTimeout(initialTimer);
    // Stop future frames immediately, but drain the single bounded request before
    // terminal delivery. Presentation requests never enter autoRetry pauses.
    typingAbort.abort(); signal?.removeEventListener('abort', stop);
    return Promise.allSettled([edits, typingPending]).finally(() => editsAbort.abort());
  };
  if (signal?.aborted) stop();
  else {
    signal?.addEventListener('abort', stop, { once: true });
    typing();
    if (preparing) { initialTimer = timers.setTimeout(() => { frame++; tick(); }, 500); initialTimer?.unref?.(); }
    else tick();
    typingTimer = timers.setInterval(typing, 4000);
    animationTimer = timers.setInterval(() => { frame++; tick(); }, 2000);
    typingTimer?.unref?.(); animationTimer?.unref?.();
  }
  return {
    stop,
    beginThinking() {
      if (stopped) return;
      if (initialTimer !== undefined) timers.clearTimeout(initialTimer);
      timers.clearInterval(animationTimer); timers.clearInterval(typingTimer);
      preparing = false; start = now(); frame = 0; lastEdit = -Infinity; tool = null; typing(); tick();
      animationTimer = timers.setInterval(() => { frame++; tick(); }, 2000);
      typingTimer = timers.setInterval(typing, 4000);
      animationTimer?.unref?.(); typingTimer?.unref?.();
    },
    onStatus(event) {
      if (stopped || event.kind === 'init') return;
      tool = event.kind === 'tool' ? event : null;
      tick();
    },
  };
}

// Original tool-detail formatter (vendor C4A).
function formatToolInput(A, Q) {
  let Y = C => C.length > 35 ? C.slice(0, 34) + "…" : C;
  let J = C => String(C ?? "").trim();
  switch (A) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      {
        let C = J(Q.file_path || Q.path);
        if (!C) {
          return "";
        }
        let F = C.replace(/\\/g, "/").split("/").filter(Boolean);
        return Y(F.slice(-2).join("/"));
      }
    case "Bash":
      {
        let F = J(Q.command).trim().split(`
`).map(U => U.trim()).filter(Boolean);
        if (F.length <= 1) {
          return Y(F[0] ?? "");
        }
        return Y(`${F[0]} … ${F[F.length - 1]}`);
      }
    case "Glob":
      return Y(J(Q.pattern));
    case "Grep":
      return Y(J(Q.pattern));
    case "WebFetch":
      return Y(J(Q.url).replace(/^https?:\/\//, ""));
    case "WebSearch":
      return Y(J(Q.query));
    default:
      {
        for (let C of ["command", "cmd", "query", "q", "path", "file_path", "filePath", "url", "pattern", "prompt"]) {
          let F = Q[C];
          if (typeof F !== "string") {
            continue;
          }
          let U = F.split(`
`).map(Z => Z.trim()).filter(Boolean)[0] ?? "";
          if (U) {
            return Y(U);
          }
        }
        return "";
      }
  }
}
