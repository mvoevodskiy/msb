/**
 * Settings wizard UI for project routing. Callbacks → [routes/routing](../routes/routing.mjs).
 */
import { InlineKeyboard } from 'grammy';
import { ROUTING_MODES, ROUTING_MODE_LABELS } from '../../projects/routing-modes.mjs';
import { escapeHtml } from '../edit.mjs';
import { BLANK } from './shared.mjs';

const PROVIDER_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  qwen: 'Qwen',
  grok: 'Grok',
  openai: 'OpenAI-совм.',
};

export function providerLabel(id) {
  return PROVIDER_LABELS[id] || id;
}

export function routingSettingsHome({
  loaded = null,
  cwd,
  projectName = null,
  mode = null,
  error = null,
} = {}) {
  const enabled = loaded?.settings?.routing?.enabled !== false;
  const kb = new InlineKeyboard();
  kb.text('🧙 Мастер настройки', 'settings:routing:wiz').row();
  if (loaded && enabled) {
    kb.text('🎛 Текущий режим', 'routing:home').row();
    kb.text('⏸ Выключить', 'settings:routing:disable').row();
  } else if (loaded && !enabled) {
    kb.text('▶ Включить', 'settings:routing:enable').row();
  }
  if (loaded) kb.text('🗑 Удалить файл', 'settings:routing:delete').row();
  kb.text('« Назад', 'settings:back');

  const where = projectName
    ? `проект <code>${escapeHtml(projectName)}</code>`
    : 'базовый <code>~/workspace</code>';
  const lines = [
    '<b>🎛 Маршрутизация задач</b>',
    '',
    `Каталог: ${where}`,
    `<code>${escapeHtml(cwd)}</code>`,
    '',
  ];
  if (error) lines.push(`❌ ${escapeHtml(error)}`, '');
  if (!loaded) {
    lines.push(
      'Сейчас выключена: нет <code>.msb/settings.yaml</code>.',
      'Мастер создаст файл и привяжет режимы ask/make/study/check/run к провайдерам.',
      'То же можно сделать в диалоге с агентом — он умеет писать этот файл.',
    );
  } else {
    const { routing } = loaded.settings;
    lines.push(
      `Файл: <code>${escapeHtml(loaded.path)}</code>`,
      enabled
        ? 'Статус: <b>включена</b> (<code>enabled: true</code>)'
        : 'Статус: <b>выключена</b> (<code>enabled: false</code>) — файл сохранён',
      `По умолчанию: <b>${escapeHtml(ROUTING_MODE_LABELS[routing.default] || routing.default)}</b> (${escapeHtml(routing.apply)})`,
      mode ? `Закреплённый режим: <b>${escapeHtml(ROUTING_MODE_LABELS[mode] || mode)}</b>` : 'Закреплённый режим: нет',
      '',
      ...ROUTING_MODES.map(id => {
        const row = routing.types[id];
        const model = row.model ? ` / ${row.model}` : '';
        return `• <b>${escapeHtml(ROUTING_MODE_LABELS[id])}</b> → ${escapeHtml(providerLabel(row.provider))}${escapeHtml(model)}`;
      }),
      '',
      enabled
        ? 'Смена режима: /type или префикс <code>#make</code> / <code>#анализ</code>.'
        : 'Включи флагом или кнопкой «Включить», чтобы снова применять маршруты.',
    );
  }
  lines.push(BLANK);
  return { text: lines.join('\n'), keyboard: kb };
}

export function routingWizardDefaultScreen(draft) {
  const kb = new InlineKeyboard();
  ROUTING_MODES.forEach((id, i) => {
    if (i && i % 3 === 0) kb.row();
    kb.text((draft.default === id ? '✓ ' : '') + ROUTING_MODE_LABELS[id], `settings:routing:wiz:default:${id}`);
  });
  kb.row().text('✖ Отмена', 'settings:routing:wiz:cancel');
  return {
    text: [
      '<b>🧙 Мастер · шаг 1/3</b>',
      '',
      'Какой режим по умолчанию, если не указан <code>#…</code> и не закреплён /type?',
      BLANK,
    ].join('\n'),
    keyboard: kb,
  };
}

export function routingWizardApplyScreen(draft) {
  const kb = new InlineKeyboard()
    .text((draft.apply === 'sticky' ? '✓ ' : '') + 'Sticky — держать режим', 'settings:routing:wiz:apply:sticky').row()
    .text((draft.apply === 'once' ? '✓ ' : '') + 'Once — только на сообщение', 'settings:routing:wiz:apply:once').row()
    .text('✖ Отмена', 'settings:routing:wiz:cancel');
  return {
    text: [
      '<b>🧙 Мастер · шаг 2/3</b>',
      '',
      'Как помнить выбранный режим?',
      '• <b>sticky</b> — до следующей явной смены (/type)',
      '• <b>once</b> — /type действует на один следующий ход; <code>#…</code> всегда на одно сообщение',
      BLANK,
    ].join('\n'),
    keyboard: kb,
  };
}

export function routingWizardProviderScreen(draft, mode, availableProviders) {
  const kb = new InlineKeyboard();
  availableProviders.forEach((id, i) => {
    if (i && i % 2 === 0) kb.row();
    const selected = draft.types[mode]?.provider === id;
    kb.text((selected ? '✓ ' : '') + providerLabel(id), `settings:routing:wiz:prov:${mode}:${id}`);
  });
  kb.row().text('✖ Отмена', 'settings:routing:wiz:cancel');
  const index = ROUTING_MODES.indexOf(mode) + 1;
  return {
    text: [
      `<b>🧙 Мастер · провайдеры ${index}/${ROUTING_MODES.length}</b>`,
      '',
      `Режим <b>${escapeHtml(ROUTING_MODE_LABELS[mode])}</b> (<code>${mode}</code>) — какой CLI?`,
      BLANK,
    ].join('\n'),
    keyboard: kb,
  };
}

export function routingWizardModelScreen(draft, mode) {
  const provider = draft.types[mode]?.provider || 'claude';
  const kb = new InlineKeyboard();
  if (provider === 'claude') {
    for (const model of ['sonnet', 'opus', 'haiku']) {
      const selected = draft.types[mode]?.model === model;
      kb.text((selected ? '✓ ' : '') + model, `settings:routing:wiz:model:${mode}:${model}`).row();
    }
  }
  kb.text('Пропустить (null)', `settings:routing:wiz:model:${mode}:skip`).row();
  kb.text('✖ Отмена', 'settings:routing:wiz:cancel');
  return {
    text: [
      `<b>🧙 Мастер · модель для ${escapeHtml(ROUTING_MODE_LABELS[mode])}</b>`,
      '',
      `Провайдер: <b>${escapeHtml(providerLabel(provider))}</b>`,
      provider === 'claude'
        ? 'Выбери семейство Claude или пропусти.'
        : 'Для этого CLI можно пропустить — останется текущая/native модель.',
      BLANK,
    ].join('\n'),
    keyboard: kb,
  };
}

export function routingWizardConfirmScreen(draft, cwd) {
  const kb = new InlineKeyboard()
    .text('✔ Сохранить', 'settings:routing:wiz:save').row()
    .text('✖ Отмена', 'settings:routing:wiz:cancel');
  const lines = [
    '<b>🧙 Мастер · подтверждение</b>',
    '',
    `Записать в <code>${escapeHtml(pathJoinMsb(cwd))}</code>?`,
    `default: <code>${draft.default}</code>, apply: <code>${draft.apply}</code>`,
    '',
    ...ROUTING_MODES.map(mode => {
      const row = draft.types[mode];
      return `• ${ROUTING_MODE_LABELS[mode]} → ${providerLabel(row.provider)}` +
        (row.model ? ` / ${row.model}` : '');
    }),
    BLANK,
  ];
  return { text: lines.join('\n'), keyboard: kb };
}

export function routingDisableConfirmScreen() {
  return {
    text: 'Выключить маршрутизацию?\nФайл останется: в нём будет <code>enabled: false</code>.',
    keyboard: new InlineKeyboard()
      .text('⏸ Да, выключить', 'settings:routing:disable:yes')
      .text('« Нет', 'settings:routing'),
  };
}

export function routingDeleteConfirmScreen() {
  return {
    text: 'Удалить <code>.msb/settings.yaml</code> полностью?',
    keyboard: new InlineKeyboard()
      .text('🗑 Да, удалить', 'settings:routing:delete:yes')
      .text('« Нет', 'settings:routing'),
  };
}

function pathJoinMsb(cwd) {
  return String(cwd || '').replace(/\/?$/, '/') + '.msb/settings.yaml';
}
