/**
 * Экраны Telegram: адаптация прежнего поведения и навигации к открытому ядру.
 * Источник: vendor/deobfuscated.js (Ph, Ky, mK, mE, autonomy, monitor, mcp…).
 * Совместимый фасад экспортов; реализации сгруппированы в screens/.
 * Навигация: [Telegram](./README.md).
 */
export { hubKeyboard, hubScreen } from './screens/hub.mjs';
export { agentScreen, modelScreen, modelVersionsScreen, effortScreen, permModeScreen, connScreen, setupScreen } from './screens/agent.mjs';
export { settingsScreen, envScreen, envDeleteScreen, tzScreen, limitScreen, serverStatusScreen, notificationsScreen } from './screens/settings.mjs';
export {
  extrasScreen,
  pultScreen,
  pultListenScreen,
  updatesScreen,
  restartConfirmScreen,
  sshUnavailableScreen,
  sttScreen,
} from './screens/system.mjs';
export { enginesScreen } from './screens/engines.mjs';
export { autonomyHomeScreen, autonomyWhatScreen, autonomyTasksScreen, autonomyHistoryScreen, autonomyRightsScreen } from './screens/autonomy.mjs';
export { autonomyTimersScreen } from './screens/legacy-timers.mjs';
export { monitorScreen, monitorSourcesScreen, monitorDigestScreen, monitorHelpScreen, monitorSettingsScreen } from './screens/monitor.mjs';
export { botsScreen, botDetailScreen } from './screens/bots.mjs';
export { mcpScreen, mcpWorkspaceScreen, mcpAddScreen } from './screens/workspace.mjs';
export { sessionsScreen, statusScreen } from './screens/sessions.mjs';
export { placeholder } from './screens/shared.mjs';

export {projectsScreen} from './screens/projects.mjs';

export {skillsScreen} from './screens/skills.mjs';
