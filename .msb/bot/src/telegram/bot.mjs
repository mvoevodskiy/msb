import { beginCommandRender, runCallbackScope, trackCallbackTask, callbackTransportSignal, openCallbackRenders, stopCallbackRenders, cancelCallbackRenders, drainCallbackTasks } from '../../shared/callback-renders.mjs';
import {resetCliConversation} from '../sessions/selection.mjs';
/**
 * createBot собирает входящие Telegram события и lifecycle хода; UI не хранит
 * provider session отдельно. Вход: [main](../main.mjs), owner → [auth](./auth.mjs).
 * Текст/voice/вложения и [таймер](../autonomy/legacy-dispatch.mjs) → [inbox](./inbox.mjs) → executeTurn → [agent](../agent/turn.mjs).
 * UI read/delivery lifecycle → [shared callbacks](../../shared/callback-renders.mjs).
 * Кнопки → [router](./router.mjs) → routes/; вид → [screens](./screens.mjs).
 * Карточка после знакомства Codex → [services](./bootstrap-services.mjs).
 * Формы → [dispatcher](./forms.mjs); pending в этом процессе; записи → [state](../state.mjs) / [env](../env/store.mjs).
 * Индикация → [progress](./progress.mjs), итог → [response](./response.mjs).
 * Вложения → [attachments](./attachments.mjs).
 * Owner stop may deliver the frozen [Claude fragment](../agent/claude.mjs) without running response actions.
 * Диагностика CLI добавляется после обработки подлинного текста модели.
 * План/комментарий → [plan actions](./plan-actions.mjs) → тот же inbox; final marker → [plan](./plan.mjs).
 * Лимиты автономки из ответа → [limit markers](./limit-markers.mjs) → [подтверждение](./limit-confirmation.mjs).
 * журнал Пульта → [history](./history.mjs), STT → [voice](./voice.mjs).
 * /cost → [saved spend view](./screens/spend.mjs); saved owner pause gates the model turn.
 * Final [reminder](./reminder-markers.mjs) and [owner pause](./pause-markers.mjs), then installation markers.
 * Model skill markers → [processor](../skills/response-markers.mjs) before plan/delivery/history, never UI metadata.
 * Prepared skills views/chunks → [view delivery](./view-delivery.mjs), context reply retained.
 * Skills command read options/OC loading → [read presentation](./skills-read.mjs), native OC reader is injectable.
 * Проверки: [inbox lifecycle](../../tests/inbox-lifecycle.test.mjs),
 * [polling/stop](../../tests/turn-lifecycle.test.mjs), [forms/menu](../../tests/menu-handlers.test.mjs),
 * [attachments](../../tests/attachments.test.mjs).
 */
import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { presentationAwareRetry, presentationSignal } from './presentation-api.mjs';
import { handleFormInput } from './forms.mjs';
import { BOOTSTRAP_SERVICE_INPUT, PendingInputs, pendingInputNotice } from './pending-input.mjs';
import { bootstrapServiceOwnsInput, deliverBootstrapServices } from './bootstrap-services.mjs';
import { recognizeVoice, voicePreview, STT_ONBOARDING } from './voice.mjs';
import { attachmentStatusText, createAttachmentAlbums, prepareAttachment } from './attachments.mjs';
import { startTurnProgress } from './progress.mjs';
import { createInbox, isForwarded } from './inbox.mjs';
import { prepareBatch, batchStatus } from './batch.mjs';
import { createPlanActions } from './plan-actions.mjs';
import { parsePlanResponse } from './plan.mjs';
import { deliverTurnResponse } from './response.mjs';
import { deliverView } from './view-delivery.mjs';
import { processPauseMarkers } from './pause-markers.mjs';
import { processGroupTaskRemovalMarkers, processTaskCancelMarkers } from './task-removal-markers.mjs';
import { prepareTaskRescheduleMarkers, processTaskRescheduleMarkers } from './task-reschedule-markers.mjs';
import { prepareTaskTextMarkers, processTaskTextMarkers, restoreTaskTextLiterals } from './task-text-markers.mjs';
import { prepareLegacyTimerMarkers, processLegacyTimerMarkers, restoreLegacyTimerLiterals } from './legacy-timer-markers.mjs';
import { processTaskControlMarkers } from './task-control-markers.mjs';
import { processTaskInspectionMarkers } from './task-inspection-markers.mjs';
import { processLimitMarkers } from './limit-markers.mjs';
import { processReminderMarkers } from './reminder-markers.mjs';
import { processInstallMarkers } from './install-markers.mjs';
import { stripMcpMarkerPayloads } from '../mcp/response-markers.mjs';
import { registerProjectCommands } from './project-commands.mjs';
import {prepareSkillRead,skillReadOptions} from './skills-read.mjs';
import {readOpenClawSkills as nativeOpenClawSkills} from '../skills/openclaw.mjs';
import { beginTurnHistory } from './history.mjs';
import { runAgentTurn } from '../agent/turn.mjs';
import { BOOTSTRAP_GREETING, codexBootstrapScope, needsCodexIntroduction } from '../agent/codex-bootstrap.mjs';
import { compactSession } from '../agent/compact.mjs';
import { trySessionOperation } from '../agent/session-operation.mjs';
import { hasClaudeAuth, loadState, updateState } from '../state.mjs';
import { addTask, tryParseScheduleMessage } from '../autonomy/store.mjs';
import { adminGuard, isAdmin, isSetupMode } from './auth.mjs';
import { HELP_CC, HELP_OC, commandsForEngine } from './commands.mjs';
import { handleCallback } from './router.mjs';
import { costScreen, hubScreen, monitorScreen, setupScreen, settingsScreen } from './screens.mjs';
import { SPEND_PAUSED } from '../billing/owner-spend.mjs';

/**
 * @param {ReturnType<import('../config.mjs').readConfig>} cfg
 */
export function createBot(cfg, { bot = new Bot(cfg.botToken), runTurn = runAgentTurn, readOpenClawSkills = nativeOpenClawSkills, now = Date.now, restart = () => setTimeout(() => process.exit(0), 600) } = {}) {
  bot.api.config.use(presentationAwareRetry(autoRetry()));

  /** Active turns outlive the polling handler; keep ownership until delivery finishes. */
  const running = new Map();
  // Includes completed deliveries whose journal is still flushing after chat unlock.
  const unfinished = new Set();
  /** @type {Map<number, string>} */
  const pending = new PendingInputs({ now });

  // Every supported agent input enters one worker; commands/forms remain immediate.
  const inbox = createInbox({
    canRun: () => !stopping && running.size === 0,
    status: showInboxStatus,
    cancel: async (entry, merged = false) => {
      await entry.presentation?.catch(() => {});
      if (entry.status) {
        if (merged) await entry.ctx.api.deleteMessage(entry.ctx.chat.id, entry.status.message_id, presentationSignal(AbortSignal.timeout(15_000))).catch(() => {});
        else await showInboxStatus(entry, 'Моя остановочка ✋🏽⛔️');
      }
    },
    run: (entry) => {
      const turn = { controller: new AbortController(), completed: false, done: null };
      running.set(entry.ctx.chat.id, turn); unfinished.add(turn);
      turn.done = executeTurn(entry.ctx, entry.text || '', turn, entry.voice, entry)
        .catch(() => console.error('[msb/bot] turn delivery failed'))
        .finally(() => unfinished.delete(turn));
      return turn.done;
    },
  });
  const albums = createAttachmentAlbums({
    onReady: (entry) => {
      if (stopping) return;
      entry.ready = undefined;
      inbox.push(entry);
    },
  });
  function showInboxStatus(entry, text) {
    const revision = entry.statusRevision = (entry.statusRevision || 0) + 1;
    entry.presentation = (entry.presentation || Promise.resolve()).catch(() => {}).then(async () => {
      if (entry.cancelled && text !== 'Моя остановочка ✋🏽⛔️') return;
      if (text.startsWith('📥 Собираю') && revision !== entry.statusRevision) return;
      const ctx = entry.ctx, thread = (ctx.message || ctx.callbackQuery?.message)?.message_thread_id;
      if (entry.status) await ctx.api.editMessageText(ctx.chat.id, entry.status.message_id, text, {}, presentationSignal(AbortSignal.timeout(15_000)));
      else entry.status = await ctx.reply(text, thread && thread !== 1 ? { message_thread_id: thread } : {}, presentationSignal(AbortSignal.timeout(15_000)));
    });
    return entry.presentation;
  }

  let stopping = false;
  let stopEpoch = 0;
  bot[Symbol.for('msb.scheduledTurns')] = {
    reserve({ chatId, userId, text }) {
      const destination = Number(chatId);
      if (stopping || !Number.isSafeInteger(destination) || !destination ||
          !isAdmin({ from: { id: userId } }, cfg.adminId)) return null;
      const ctx = {
        chat: { id: destination }, api: bot.api,
        reply: (...args) => bot.api.sendMessage(destination, ...args),
      };
      return inbox.reserveScheduled({ ctx, text });
    },
    get pending() { return inbox.hasScheduled; },
    get stopEpoch() { return stopEpoch; },
  };
  const plan = createPlanActions({ enqueue: (ctx, text) => {
    if (!stopping) inbox.push({ ctx, text, voice: false });
  } });
  const startPolling = bot.start.bind(bot);
  bot.start = (...args) => { stopping = false; openCallbackRenders(bot); inbox.open(); return startPolling(...args); };
  const stopPolling = bot.stop.bind(bot);
  bot.stop = async () => {
    stopping = true;
    pending.clear();
    albums.clear();
    stopCallbackRenders(bot);
    const turns = [...unfinished];
    const drainInbox = inbox.shutdown();
    for (const turn of turns) if (!turn.completed) turn.controller.abort();
    try { await stopPolling(); }
    finally { await Promise.allSettled([...turns.map((turn) => turn.done), drainInbox, drainCallbackTasks(bot)]); }
  };

  bot.use(adminGuard(cfg.adminId));
  bot[Symbol.for('msb.openClawSkillsReader')]=readOpenClawSkills;
  bot[Symbol.for('msb.cancelPendingInput')] = (chatId) => pending.delete(chatId);
  bot.use(async (ctx, next) => {
    if (/^\/(?:start|settings|stop)(?:@[\w_]+)?(?:\s|$)/.test(ctx.message?.text || '')) cancelCallbackRenders(bot, ctx.chat?.id);
    if (/^\/start(?:@[\w_]+)?(?:\s|$)/.test(ctx.message?.text || '')) pending.delete(ctx.chat?.id);
    return next();
  });

  bot.command('start', async (ctx) => {
    const state = await updateState((s, { exists }) => {
      // Old Q1 initializes xhigh only when the profile file is absent.
      const newProfile = !exists;
      s.chatId = ctx.chat.id;
      s.userId = ctx.from?.id;
      s.ownerUsername = ctx.from?.username || null;
      if (newProfile && s.ccEffort === undefined) s.ccEffort = 'xhigh';
      if (s.dailySpendLimit === undefined) s.dailySpendLimit = 10;
      if (s.timezone === undefined) s.timezone = cfg.timezone;
      return s;
    });
    if (isSetupMode(state)) {
      const view = setupScreen();
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
      return;
    }
    const scope = codexBootstrapScope(ctx.chat.id, ctx.from?.id, ctx.message?.message_thread_id);
    if (await needsCodexIntroduction(state, scope)) {
      await ctx.reply(BOOTSTRAP_GREETING);
      return;
    }
    const view = hubScreen();
    await ctx.reply(view.text, { reply_markup: view.keyboard });
    if (state.codexServiceSetup?.scope === scope && scope && !running.has(ctx.chat.id)) {
      await deliverBootstrapServices(ctx);
    }
  });

  bot.command('help', async (ctx) => {
    const { state } = await loadState();
    await ctx.reply(state.engine === 'oc' ? HELP_OC : HELP_CC, { parse_mode: 'HTML' });
  });

  bot.command('claude', async (ctx) => {
    await ctx.reply(`<b>Режим Claude</b> — что доступно в этом режиме:\n\n${HELP_CC}`, {
      parse_mode: 'HTML',
    });
  });

  bot.command('openclaw', async (ctx) => {
    if (process.env.JARVIS_CC_ONLY === '1') {
      await ctx.reply(
        'Этот бот работает только с 👾 Claude Code.\nOpenClaw: /settings → ⚙️ Движки → ➕ OpenClaw.',
      );
      return;
    }
    await ctx.reply(`<b>Режим OpenClaw</b> — что доступно в этом режиме:\n\n${HELP_OC}`, {
      parse_mode: 'HTML',
    });
  });

  bot.command('settings', async (ctx) => {
    const { state } = await loadState();
    const view = settingsScreen(state);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  });

  bot.command('pult', async (ctx) => {
    try {
      const { buildPultCommandKeyboard } = await import('../pult/client.mjs');
      const view = await buildPultCommandKeyboard();
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
    } catch (err) {
      await ctx.reply(
        `Пульт недоступен: ${err.message}\n\nВключи в /settings → Системные → Пульт (нужен пароль).`,
      );
    }
  });

  bot.command('monitor', async (ctx) => {
    const view = await monitorScreen();
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  });
  bot.command('digest', async (ctx) => {
    const { buildDigestText } = await import('../monitor/digest.mjs');
    const dig = await buildDigestText();
    await ctx.reply(dig.text, { parse_mode: 'HTML' });
  });
  bot.command('sources', async (ctx) => {
    const { monitorSourcesScreen } = await import('./screens.mjs');
    const view = await monitorSourcesScreen();
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  });


  function interruptActiveTurns() {
    const turns = [...running.values()].filter(turn => !turn.completed);
    for (const turn of turns) {
      if (!turn.controller.signal.aborted) turn.interruptedByUser = true;
      turn.controller.abort();
    }
    return turns.length > 0;
  }

  bot.command('stop', async (ctx) => {
    stopEpoch++;
    albums.clear();
    const queued = inbox.clear();
    if (interruptActiveTurns() || queued) {
      await ctx.reply('Моя остановочка ✋🏽⛔️');
    } else {
      await ctx.reply('Нечего останавливать 🤷');
    }
  });

  bot.command('newtask', async (ctx) => {
    const state=await resetCliConversation();
    await ctx.reply(state.engine==='oc'?'Новая сессия. Пиши задачу.':'🆕 Новая сессия. Предыдущий контекст сброшен.');
  });

  bot.command('clear', async (ctx) => {
    const bootstrapScope = codexBootstrapScope(ctx.chat.id, ctx.from?.id, ctx.message?.message_thread_id);
    const state=await resetCliConversation(process.env, { bootstrapScope });
    await ctx.reply(state.engine==='oc'?'Начата новая беседа. Файлы и native-история сохранены.':'🧹 Контекст сброшен. Начинаем с чистого листа.');
  });

  bot.command('compact', async (ctx) => {
    const chatId = ctx.chat.id;
    if (stopping) return;
    if (running.size || inbox.size) {
      await ctx.reply('Уже работаю над предыдущим сообщением. /stop — прервать.');
      return;
    }
    const release = trySessionOperation();
    if (!release) {
      await ctx.reply('⏳ Сейчас идёт фоновый ход — повтори /compact, когда освобожусь.');
      return;
    }
    const turn = { controller: new AbortController(), completed: false, done: null, compacting: true };
    running.set(chatId, turn);
    unfinished.add(turn);
    turn.done = executeCompact(ctx, turn, release).catch((err) => {
      console.error('[msb/bot] compact delivery failed:', err.message);
    }).finally(() => unfinished.delete(turn));
  });

  bot.command('undo', async (ctx) => {
    await ctx.reply('Автоматическая отмена правок через /undo пока не подключена. Опиши агенту, какую правку нужно вернуть.');
  });

  bot.command('sessions', async (ctx) => {
    const { sessionsScreen } = await import('./screens.mjs');
    const { state } = await loadState();
    const view = await sessionsScreen(state,process.env,0,{fromMenu:false});
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard,
      ...(view.disablePreview?{link_preview_options:{is_disabled:true}}:{}) });
  });

  registerProjectCommands(bot,pending);

  bot.command('skills', (ctx) => {
    const scope=beginCommandRender(bot,ctx.message);
    const task=runCallbackScope(scope,async()=>{
      const {skillsScreen}=await import('./screens.mjs');
      const {state}=await loadState();if(!scope.isCurrent())return;
      if(!await prepareSkillRead(bot,state,{chatId:ctx.chat.id,signal:scope.signal}))return;
      const view=await skillsScreen(state,process.env,skillReadOptions(bot,scope.signal));
      await deliverView(view,{scope,reply:part=>scope.render(()=>ctx.reply(part.text,{parse_mode:'HTML',reply_markup:part.keyboard},callbackTransportSignal(scope)))});
    }).catch(()=>{if(!scope.signal.aborted)console.error('[msb/bot] skills read failed');});
    trackCallbackTask(bot,task);
  });

  bot.command('status', async (ctx) => {
    const { state } = await loadState();
    const { statusScreen } = await import('./screens.mjs');
    const view = await statusScreen(state, cfg);
    await ctx.reply(view.text, { parse_mode: 'HTML' });
  });

  bot.command('cost', async (ctx) => {
    const { state } = await loadState();
    await ctx.reply(costScreen(state, now()).text, { parse_mode: 'HTML' });
  });

  bot.command('autostatus', async (ctx) => {
    if (running.has(ctx.chat.id)) {
      await ctx.reply('⏳ Сейчас идёт ход — повтори /autostatus, когда освобожусь.');
      return;
    }
    const { autonomyHistoryScreen } = await import('./screens.mjs');
    const view = await autonomyHistoryScreen({ limit: ctx.match, menu: false });
    for (let i = 0; i < view.pages.length; i++) {
      await ctx.reply(view.pages[i], {
        parse_mode: 'HTML',
        ...(i === view.pages.length - 1 ? { reply_markup: view.keyboard } : {}),
      });
    }
  });

  bot.command('autoactions', async (ctx) => {
    const { autonomyTasksScreen } = await import('./screens.mjs');
    const view = await autonomyTasksScreen(
      undefined,
      Boolean(bot[Symbol.for('msb.savedCodexPrompt')]),
      Boolean(bot[Symbol.for('msb.savedCursorPrompt')]),
    );
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  });

  bot.command('connect', async (ctx) => {
    await ctx.reply(
      'VS Code туннель: скажи агенту поднять code-server/tunnel или открой /settings → Системные → SSH. Эта команда сама туннель не запускает.',
    );
  });

  bot.command('recovery', async (ctx) => {
    await ctx.reply(
      'Аварийный доступ: используй существующее SSH-подключение или консоль хостера. Меню SSH — /settings → Системные → SSH.',
    );
  });

  bot.command('feedback', async (ctx) => {
    const text = ctx.match?.trim();
    if (text) {
      await handleFormInput({ kind: 'feedback', ctx, text, pending });
      return;
    }
    pending.set(ctx.chat.id, 'feedback');
    await ctx.reply('Напиши отзыв следующим сообщением — сохраню в workspace/ops/feedback.md.');
  });

  bot.on('callback_query:data', async (ctx) => {
    await handleCallback({ bot, cfg, pending, ctx, plan, now });
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text || '';
    const chatId = ctx.chat.id;
    const entry = pending.read(chatId);
    if (entry.kind === BOOTSTRAP_SERVICE_INPUT && !bootstrapServiceOwnsInput(ctx, pending.payload(chatId))) {
      entry.kind = undefined;
    }
    const notice = pendingInputNotice(entry, text);
    if (notice) {
      pending.delete(chatId);
      await ctx.reply(notice, { parse_mode: 'HTML' });
      return;
    }
    if(entry.kind==='new-project' && text.trimStart().startsWith('/')) {pending.delete(chatId);return;}
    if (text.startsWith('/')) return;

    const pend = entry.kind;
    if (await handleFormInput({ kind: pend, ctx, text, pending, cfg, restart })) return;

    if (await plan.consumeComment(ctx, text)) return;

    // Old reply-stop interrupts the current turn, but keeps collectors/FIFO.
    // Env/auth forms above keep priority; timezone input below remains pending.
    if (text.toLowerCase() === 'стоп' && ctx.message.reply_to_message) {
      if (interruptActiveTurns()) await ctx.reply('Моя остановочка ✋🏽⛔️');
      return;
    }
    if (pend === 'timezone') {
      const timezone = text.trim();
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
      catch { await ctx.reply('Неизвестный часовой пояс. Например: Europe/Moscow.'); return; }
      pending.delete(chatId);
      await updateState((s) => {
        s.timezone = timezone;
        return s;
      });
      await ctx.reply(`Часовой пояс: <code>${escapeHtml(timezone)}</code>`, { parse_mode: 'HTML' });
      return;
    }
    const { state } = await loadState();
    if (isSetupMode(state)) {
      const view = setupScreen();
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
      return;
    }

    const batchInput = isForwarded(ctx.message) || inbox.isCollecting(ctx);
    const scheduled = !batchInput && tryParseScheduleMessage(text);
    if (scheduled) {
      const task = await addTask(scheduled);
      await ctx.reply(
        `Задача сохранена: <b>${escapeHtml(task.title)}</b>\nКаждые ${task.everyHours} ч.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // The named OpenClaw runner validates its own native profile.
    if (state.engine !== 'oc' && !hasClaudeAuth(process.env, state)) {
      const view = setupScreen();
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
      return;
    }

    if (stopping) return;
    inbox.push({ ctx, text, voice: false });
  });

  async function executeCompact(ctx, turn, release) {
    const chatId = ctx.chat.id;
    const signal = turn.controller.signal;
    let status, typing;
    let typingBusy = false;
    const typingAbort = new AbortController();
    presentationSignal(typingAbort.signal);
    const stopTyping = () => { clearInterval(typing); typingAbort.abort(); };
    signal.addEventListener('abort', stopTyping, { once: true });
    const reply = (text, abort = AbortSignal.timeout(15_000)) =>
      ctx.reply(text, {}, presentationSignal(abort));
    const edit = async (text) => {
      if (status?.message_id) {
        try {
          await ctx.api.editMessageText(chatId, status.message_id, text, {}, presentationSignal(AbortSignal.timeout(15_000)));
          return;
        } catch { /* reply below */ }
      }
      await reply(text);
    };
    try {
      const { state } = await loadState();
      if (signal.aborted) return;
      if (!state.ccSessionId && state.engine !== 'oc') {
        await reply('Нет активной CC-сессии. Напиши что-нибудь сначала.');
        return;
      }
      status = await reply('🗜️ Сжимаю контекст...', AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
      if (signal.aborted) { await edit('Моя остановочка ✋🏽⛔️'); return; }
      const tick = () => {
        if (typingBusy || typingAbort.signal.aborted) return;
        typingBusy = true;
        Promise.resolve().then(() => {
          if (!typingAbort.signal.aborted) return ctx.api.sendChatAction(chatId, 'typing', {}, typingAbort.signal);
        })
          .catch(() => {}).finally(() => { typingBusy = false; });
      };
      tick();
      typing = setInterval(tick, 4_000);
      typing.unref?.();
      const isCurrent = async () => {
        const current = (await loadState()).state;
        return current.ccSessionId === state.ccSessionId && current.engine === state.engine &&
          current.extAuthBypass === state.extAuthBypass && (current.sessionEpoch || 0) === (state.sessionEpoch || 0);
      };
      const result = await compactSession(state, {
        signal, isCurrent, compactProvider: bot[Symbol.for('msb.compactProvider')],
      });
      stopTyping();
      if (!signal.aborted) turn.completed = true;
      if (signal.aborted) await edit('Моя остановочка ✋🏽⛔️');
      else if (result.aborted) await edit('Сессия или движок изменились; сжатие не запускалось.');
      else if (result.ok && result.compacted === false) await edit(result.text);
      else if (result.ok) {
        await edit(await isCurrent() ? '🗜️ Контекст успешно сжат. Жду команду.' : '🗜️ Контекст прежней сессии успешно сжат.');
      } else await edit(`Не получилось сжать: ${result.error || 'действие не подтверждено'}`);
    } catch {
      if (signal.aborted) await edit('Моя остановочка ✋🏽⛔️').catch(() => {});
      else await edit('Не получилось сжать: ошибка запуска.').catch(() => {});
    } finally {
      stopTyping();
      signal.removeEventListener('abort', stopTyping);
      turn.completed = true;
      if (running.get(chatId) === turn) running.delete(chatId);
      release();
      inbox.kick();
    }
  }

  async function executeTurn(ctx, text, turn, voice = false, entry = {}) {
    const chatId = ctx.chat.id;
    const signal = turn.controller.signal;
    let status;
    let progress;
    let transcription;
    let transcribed = false;
    const startedAt = performance.now();
    let history, result, outcome = 'error', deliveredText = '', delivered = false;
    let responseReady = false;
    const stopped = async () => {
      outcome = 'aborted';
      const received = turn.interruptedByUser ? result?.assistantReply : null;
      const partial = received && stripMcpMarkerPayloads(received.text).trim();
      if (partial) {
        await deliverTurnResponse(ctx, status?.message_id, partial,
          { elapsedMs: performance.now() - startedAt, context: received.context }, { allowPlan: false })
          .then(() => { deliveredText = partial; delivered = true; }).catch(() => {});
        return;
      }
      if (status) await ctx.api.editMessageText(chatId, status.message_id, 'Моя остановочка ✋🏽⛔️', {}, presentationSignal(AbortSignal.timeout(15_000)))
        .then(() => { deliveredText = 'Моя остановочка ✋🏽⛔️'; delivered = true; }).catch(() => {});
    };
    try {
      if (!voice && !entry.items && !entry.attachment) history = await beginTurnHistory({ input: text });
      const thread = (ctx.message || ctx.callbackQuery?.message)?.message_thread_id;
      try { await entry.presentation; }
      catch {
        if (entry.isAutoTurn && !entry.status) { outcome = 'delivery_error'; return; }
      }
      status = entry.status;
      if (signal.aborted) { await stopped(); return; }
      if (voice) {
        transcription = await ctx.reply('🎙 Расшифровываю...', thread && thread !== 1 ? { message_thread_id: thread } : {});
        if (signal.aborted) { await stopped(); return; }
      }
      const initialText = entry.items
        ? batchStatus(entry)
        : entry.attachment
          ? attachmentStatusText(entry.attachment === 'video' && ctx.message?.video_note ? 'video_note' : entry.attachment)
          : 'Думаю ⏳';
      if (status) await ctx.api.editMessageText(chatId, status.message_id, initialText, {}, presentationSignal(AbortSignal.any([signal, AbortSignal.timeout(15_000)])));
      else {
        const request = entry.scheduled ? presentationSignal(AbortSignal.any([signal, AbortSignal.timeout(15_000)])) : undefined;
        try {
          status = await ctx.reply(initialText, thread && thread !== 1 ? { message_thread_id: thread } : {}, request);
        } catch (error) {
          if (!entry.isAutoTurn) throw error;
          outcome = 'delivery_error';
          return;
        }
      }
      if (signal.aborted) { await stopped(); return; }
      progress = startTurnProgress(ctx, status.message_id, { signal, preparing: voice || Boolean(entry.items) || Boolean(entry.attachment) });
      if (voice) {
        const recognized = await recognizeVoice(ctx, cfg.botToken, signal);
        signal.throwIfAborted();
        const preview = voicePreview(recognized.transcript);
        try { await ctx.api.editMessageText(chatId, transcription.message_id, preview.html, { parse_mode: 'HTML' }); }
        catch { if (!signal.aborted) await ctx.api.editMessageText(chatId, transcription.message_id, preview.plain).catch(() => {}); }
        signal.throwIfAborted();
        transcribed = true;
        text = recognized.prompt;
        history = await beginTurnHistory({ input: recognized.transcript.slice(0, 300) });
        progress.beginThinking();
      }
      if (entry.attachment) {
        text = await prepareAttachment(entry, cfg.botToken, signal);
        signal.throwIfAborted();
        history = await beginTurnHistory({ input: text.slice(0, 300) });
        progress.beginThinking();
      }
      if (entry.items) {
        text = await prepareBatch(entry, cfg.botToken, signal);
        signal.throwIfAborted();
        history = await beginTurnHistory({ input: text });
        progress.beginThinking();
      }
      signal.throwIfAborted();
      const reminderOwner = !entry.isAutoTurn && isAdmin(ctx, cfg.adminId) ? cfg.adminId : 0;
      const codexAvailable = Boolean(bot[Symbol.for('msb.savedCodexPrompt')]);
      const cursorAvailable = Boolean(bot[Symbol.for('msb.savedCursorPrompt')]);
      const checkSavedCodex = codexAvailable ? bot[Symbol.for('msb.savedCodexPromptReady')] : undefined;
      const checkSavedCursor = cursorAvailable ? bot[Symbol.for('msb.savedCursorPromptReady')] : undefined;
      const { state } = await loadState();
      signal.throwIfAborted();
      const paused = Boolean(state.costPaused);
      const bootstrapScope = !entry.scheduled && ctx.message && reminderOwner && state.extAuthBypass === 'codex'
        ? codexBootstrapScope(chatId, reminderOwner, thread) : undefined;
      const out = paused ? { ok: false, text: SPEND_PAUSED } : await runTurn({ prompt: entry.prompt ?? text, signal,
        ...(reminderOwner ? { reminderOwner, checkSavedCodex, checkSavedCursor } : {}),
        ...(bootstrapScope ? { bootstrapScope } : {}),
        ...(entry.isAutoTurn ? { isAutoTurn: true } : {}), onStatus: ev => {
        if (ev.kind === 'provider') history?.provider(ev.providerId);
        progress.onStatus(ev);
      } });
      result = out.result;
      outcome = paused ? 'blocked' : out.ok ? 'ok' : 'error';
      await progress.stop();
      if (signal.aborted || out.error === 'aborted') { await stopped(); return; }
      if (out.bootstrap || out.terminalNotice || (!out.ok && result?.providerId === 'codex' && result.subtype === 'error_notice')) {
        turn.completed = true;
        responseReady = true;
        const notice = stripMcpMarkerPayloads(out.text);
        await deliverTurnResponse(ctx, status.message_id, notice, {}, { allowPlan: false });
        deliveredText = notice; delivered = true;
        if (out.bootstrapComplete) await deliverBootstrapServices(ctx);
        return;
      }
      const autonomy = {
        ownerId: reminderOwner, rail: out.reminderRail, ok: out.ok, chatId, threadId: thread,
        messageId: (ctx.message || ctx.callbackQuery?.message)?.message_id, openClawProfile: out.openClawProfile,
        timezone: cfg.timezone, now: now(), signal,
        codexAvailable, cursorAvailable, checkSavedCodex, checkSavedCursor,
      };
      const textEdits = prepareTaskTextMarkers(out.modelText ?? out.text);
      const reschedule = prepareTaskRescheduleMarkers(textEdits.text);
      const legacyTimers = prepareLegacyTimerMarkers(reschedule.text);
      const reminders = await processReminderMarkers(legacyTimers.text, autonomy);
      const pausedTasks = await processPauseMarkers(reminders, autonomy, ctx);
      const askedRemoval = await processGroupTaskRemovalMarkers(pausedTasks, autonomy, ctx);
      const inspected = await processTaskInspectionMarkers(askedRemoval, autonomy, ctx);
      const rescheduled = await processTaskRescheduleMarkers(inspected, autonomy, ctx, reschedule.commands);
      const editedTasks = await processTaskTextMarkers(rescheduled, autonomy, textEdits);
      const cancelled = await processTaskCancelMarkers(editedTasks, autonomy, ctx);
      const controlled = await processTaskControlMarkers(cancelled, autonomy);
      const timers = await processLegacyTimerMarkers(controlled, autonomy, ctx, legacyTimers);
      const actionText = await processLimitMarkers(timers, autonomy, ctx);
      const replyText = await processInstallMarkers({ ...out, text: actionText }, { signal, readProvider: bot[Symbol.for('msb.mcpProvider')] });
      signal.throwIfAborted();
      turn.completed = true;
      responseReady = true;
      const errorDisplay = result?.errorDisplay;
      const before = errorDisplay ? stripMcpMarkerPayloads(errorDisplay.before) : '';
      const after = errorDisplay ? stripMcpMarkerPayloads(errorDisplay.after) : '';
      const restoreText = value => before + restoreLegacyTimerLiterals(restoreTaskTextLiterals(value, textEdits), legacyTimers) + after;
      await deliverTurnResponse(ctx, status.message_id, replyText, out.ok || out.partialReply ? {
        elapsedMs: performance.now() - startedAt, costUsd: result?.costUsd,
        context: out.partialReply ? out.partialReply.context : result?.context,
      } : {}, { restoreText });
      deliveredText = restoreText(parsePlanResponse(replyText)?.cleanText ?? replyText); delivered = true;
    } catch (err) {
      await progress?.stop();
      if (signal.aborted) await stopped().catch(() => {});
      else {
        outcome = responseReady ? 'delivery_error' : 'error';
        turn.completed = true;
        if (voice && err.code === 'STT_NOT_CONFIGURED') {
          if (status) await ctx.api.deleteMessage(chatId, status.message_id, presentationSignal(AbortSignal.timeout(15_000))).catch(() => {});
          const thread = (ctx.message || ctx.callbackQuery?.message)?.message_thread_id;
          await ctx.reply(STT_ONBOARDING.text, { reply_markup: STT_ONBOARDING.reply_markup, ...(thread && thread !== 1 ? { message_thread_id: thread } : {}) });
        } else {
          const error = voice && !transcribed
            ? `❌ Не удалось обработать голосовое: ${String(err.message).slice(0, 200)}\n\nПопробуй ещё раз или напиши текстом.`
            : entry.attachment
              ? `❌ Ошибка: ${String(err.message).slice(0, 200)}`
              : `❌ Ошибка: ${String(err.message).slice(0, 300)}`;
          await deliverTurnResponse(ctx, status?.message_id, error, {}, { allowPlan: false });
          deliveredText = error; delivered = true;
        }
      }
    } finally {
      await progress?.stop();
      if (transcription && !transcribed) await ctx.api.deleteMessage(chatId, transcription.message_id, presentationSignal(AbortSignal.timeout(15_000))).catch(() => {});
      turn.completed = true;
      if (running.get(chatId) === turn) running.delete(chatId);
      await history?.finish({ status: signal.aborted ? 'aborted' : outcome, text: deliveredText, delivered, result });
    }
  }

  bot.on('message:voice', async ctx => {
    const { state } = await loadState();
    if (isSetupMode(state)) { await ctx.reply('Сначала подключи AI: /start'); return; }
    if (stopping) return;
    // Speech never passes through pending text forms or fabricated updates.
    inbox.push({ ctx, text: '', voice: true });
  });

  async function acceptAttachment(ctx, kind, build) {
    const { state } = await loadState();
    if (isSetupMode(state)) {
      await ctx.reply('Сначала подключи AI: /start');
      return;
    }
    if (stopping) return;
    const groupId = ctx.message?.media_group_id;
    if (groupId && (kind === 'photo' || kind === 'video' || kind === 'document')) {
      const piece = build(true);
      const entry = kind === 'photo' ? albums.addPhoto(groupId, piece)
        : kind === 'video' ? albums.addVideo(groupId, piece)
          : albums.addDocument(groupId, piece);
      if (!entry.status) {
        try {
          entry.status = await ctx.reply(
            kind === 'document' ? '📎 Получаю файлы...' : kind === 'photo' ? '🖼 Получаю медиа...' : '🎥 Получаю медиа...',
          );
        } catch { /* status optional */ }
      }
      return;
    }
    inbox.push(build(false));
  }

  bot.on('message:photo', async ctx => {
    const photos = ctx.message?.photo;
    const best = photos?.[photos.length - 1];
    if (!best) return;
    await acceptAttachment(ctx, 'photo', (album) => album
      ? { ctx, photos: [{ fileId: best.file_id, fileSize: best.file_size }], caption: ctx.message.caption }
      : { ctx, text: '', attachment: 'photo' });
  });

  bot.on(['message:video', 'message:video_note'], async ctx => {
    const video = ctx.message?.video || ctx.message?.video_note;
    if (!video) return;
    await acceptAttachment(ctx, 'video', (album) => album
      ? {
        ctx,
        videos: [{
          fileId: video.file_id,
          fileSize: video.file_size,
          duration: video.duration || 0,
          isNote: Boolean(ctx.message?.video_note),
        }],
        caption: ctx.message.caption,
      }
      : { ctx, text: '', attachment: 'video' });
  });

  bot.on('message:animation', async ctx => {
    if (!ctx.message?.animation) return;
    await acceptAttachment(ctx, 'animation', () => ({ ctx, text: '', attachment: 'animation' }));
  });

  bot.on('message:document', async ctx => {
    const doc = ctx.message?.document;
    if (!doc) return;
    await acceptAttachment(ctx, 'document', (album) => album
      ? {
        ctx,
        docs: [{
          fileId: doc.file_id,
          fileName: doc.file_name || 'document',
          fileSize: doc.file_size || 0,
          mimeType: doc.mime_type || '',
        }],
        caption: ctx.message.caption,
      }
      : { ctx, text: '', attachment: 'document' });
  });

  bot.on('message:sticker', async ctx => {
    if (!ctx.message?.sticker) return;
    await acceptAttachment(ctx, 'sticker', () => ({ ctx, text: '', attachment: 'sticker' }));
  });

  bot.on('message:audio', async ctx => {
    if (!ctx.message?.audio) return;
    await acceptAttachment(ctx, 'audio', () => ({ ctx, text: '', attachment: 'audio' }));
  });

  // set commands after start
  bot.api
    .setMyCommands(commandsForEngine('cc', process.env.JARVIS_CC_ONLY === '1'))
    .catch((err) => console.error('[msb/bot] setMyCommands failed:', err.message));

  return bot;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function runPolling(bot, { log = console.error } = {}) {
  let fastFails = 0;
  for (;;) {
    try {
      log('[msb/bot] starting polling (open-core)');
      await bot.start({
        onStart: (info) => log(`[msb/bot] @${info.username} ready`),
      });
      return;
    } catch (err) {
      const msg = String(err?.message || err);
      if (/401|Unauthorized|Not Found/i.test(msg)) {
        log(`[msb/bot] Token invalid (${msg.slice(0, 100)}). Bot will not poll Telegram.`);
        return;
      }
      try {
        await bot.stop();
      } catch {
        /* ignore */
      }
      fastFails += 1;
      if (fastFails < 5) {
        const wait = Math.min(30_000, fastFails * 5000);
        log(`[msb/bot] bot.start() failed (${fastFails}/5), retry in ${wait / 1000}s: ${msg.slice(0, 200)}`);
        await sleep(wait);
        continue;
      }
      if (/409|Conflict/i.test(msg)) {
        log('[msb/bot] 409 Conflict persists. Retrying every 300s until the path is free.');
        await sleep(300_000);
        fastFails = 0;
        continue;
      }
      log(`[msb/bot] bot.start() failed after retries: ${msg.slice(0, 200)}`);
      log('[msb/bot] Bot not polling. Heartbeat still running.');
      return;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
