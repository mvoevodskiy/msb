/**
 * Действия автономки.
 * [Telegram](../README.md), [legacy timer store](../../autonomy/legacy-timers.mjs),
 * [timer views](../screens/legacy-timers.mjs), [callback checks](../../../tests/autonomy-timers.test.mjs).
 */
import { loadState, updateState } from '../../state.mjs';
import { autonomyHistoryScreen, autonomyRightsScreen, autonomyTasksScreen, autonomyWhatScreen, placeholder } from '../screens.mjs';
import { changeLegacyTimer, listLegacyTimers } from '../../autonomy/legacy-timers.mjs';
import { autonomyTimerScreen, autonomyTimersScreen } from '../screens/legacy-timers.mjs';
import { UNHANDLED } from './shared.mjs';

export async function handleAutonomyRoute({ data, show, bot, chatId }) {
  // —— autonomy ——
  if (data === 'auto:what') return show(autonomyWhatScreen());
  if (data === 'auto:tasks') return show(await autonomyTasksScreen());
  if (data === 'auto:timers') return show(autonomyTimersScreen(await listLegacyTimers()));
  if (data.startsWith('auto:timer:')) {
    const id = data.slice('auto:timer:'.length);
    const timers = await listLegacyTimers();
    return show(autonomyTimerScreen(timers.find(timer => timer.id === id)));
  }
  const remove = data.startsWith('auto:timer-delete:');
  if (remove || data.startsWith('auto:timer-toggle:')) {
    const id = data.slice((remove ? 'auto:timer-delete:' : 'auto:timer-toggle:').length);
    let timers;
    try {
      timers = await changeLegacyTimer(id, { remove });
    } catch (error) {
      console.error('[msb/autonomy] Could not update saved timer:', error.code || error.name);
      return show(autonomyTimersScreen(await listLegacyTimers()));
    }
    return show(autonomyTimersScreen(timers, { afterChange: true }));
  }
  if (data === 'auto:history') {
    const view = await autonomyHistoryScreen();
    if (view.pages.length === 1) return show(view);
    await show({ text: view.pages[0] });
    for (let i = 1; i < view.pages.length; i++) {
      await bot.api.sendMessage(chatId, view.pages[i], {
        parse_mode: 'HTML',
        ...(i === view.pages.length - 1 ? { reply_markup: view.keyboard } : {}),
      });
    }
    return;
  }
  if (data === 'auto:rights') return show(await autonomyRightsScreen());
  if (data === 'auto:rights-toggle') {
    await updateState((s) => {
      s.autonomyRights = !s.autonomyRights;
      return s;
    });
    console.error(
      `[msb/autonomy] права фоновых задач ${(await loadState()).state.autonomyRights ? 'включены' : 'выключены'} владельцем`,
    );
    return show(await autonomyRightsScreen());
  }
  if (data.startsWith('auto:task:')) {
    const id = data.slice('auto:task:'.length);
    return show(placeholder(`Задача ${id.slice(0, 8)}`, 'auto:tasks'));
  }
  if (data.startsWith('auto:task-toggle:') || data.startsWith('auto:task-delete:')) {
    return show(await autonomyTasksScreen());
  }

  return UNHANDLED;
}
