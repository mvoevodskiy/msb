/**
 * Old MCP headings, lists, status and cards. Inputs are display metadata only.
 * [Route](../routes/workspace.mjs), [catalog](../../mcp/catalog.mjs),
 * [view checks](../../../tests/mcp-catalog.test.mjs).
 */
import {InlineKeyboard} from 'grammy';
import {escapeHtml} from '../edit.mjs';
import {mcpReference} from '../../mcp/reference.mjs';
import {BLANK} from './shared.mjs';

const back=destination=>new InlineKeyboard().text('« Назад',destination);

export function mcpScreen(count) {
  return {
    text: `🔌 <b>MCP серверы</b>

Внешние сервисы — транскрипты, скрейпинг, базы данных и другие инструменты.
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text(`📂 workspace (${count})`,'mcp:folder:workspace').row()
      .text('« Назад','menu:back'),
  };
}

export function mcpWorkspaceScreen(catalog) {
  const {entries,at}=catalog;
  const keyboard=new InlineKeyboard();
  const lines=entries.map(({name,transport,status})=>{
    keyboard.text(name,'mcp:server:'+mcpReference(catalog,name)).row();
    const server=`<b>${escapeHtml(name)}</b> (${escapeHtml(transport)})`;
    if(!status)return `[+] ${server}`;
    const reason=status==='needs-auth'?'нужен вход заново':status==='failed'?'не запускается':status;
    return `[x] ${server} — ${escapeHtml(reason)}`;
  });
  if(!lines.length)lines.push('<i>Нет серверов</i>');
  if(at)lines.push('',`<i>Состояние на ${at} UTC</i>`);
  return {
    text: `<b>📂 workspace</b>

Доступны агенту во всех проектах.

${lines.join('\n')}
${BLANK}`,
    keyboard:keyboard.text('➕ Добавить','mcp:add').row().text('« Назад','menu:mcp'),
  };
}

export function mcpCardScreen(row) {
  const name=escapeHtml(row.name);
  return {text:`🔌 <b>${name}</b>\n\nTools: <code>mcp__${name}__*</code>\n${BLANK}`,keyboard:back('mcp:folder:workspace')};
}

export function mcpMissingScreen(destination) {
  return {text:`MCP-сервер не найден.\n${BLANK}`,keyboard:back(destination)};
}

export function mcpReadErrorScreen(destination) {
  return {text:`Не удалось получить список MCP-серверов.\n${BLANK}`,keyboard:back(destination)};
}

export function openClawMcpScreen(entries) {
  const keyboard=new InlineKeyboard().text('➕ Добавить','mcp:add').row().text('« Назад','menu:back');
  const heading='🔌 <b>MCP-серверы</b>\n\n';
  if(!entries.length)return {
    text:heading+'На движке сейчас нет настроенных MCP-серверов.\n\n<i>Чтобы подключить — попроси агента: «подключи MCP сервер …».</i>',
    keyboard,
  };

  let text=heading+`Подключено к движку: <b>${entries.length}</b>. Инструменты доступны агенту как <code>mcp__имя__*</code>.\n`;
  for(const {name,transport,target} of [...entries].sort((a,b)=>a.name.localeCompare(b.name))) {
    const endpoint=target?` — <code>${escapeHtml(target.slice(0,60))}</code>`:'';
    const line=`\n• <b>${escapeHtml(name)}</b> (${escapeHtml(transport)})${endpoint}`;
    // Match the old one-message cap without splitting an HTML tag or entity.
    if(text.length+line.length>3498){text+='\n…';break;}
    text+=line;
  }
  return {text,keyboard};
}

export function mcpAddScreen() {
  return {
    text: `<b>➕ MCP сервер</b>

Прежние пункты настройки. Их установка в open-core пока не подключена.
${BLANK}`,
    keyboard: new InlineKeyboard()
      .text('Supadata', 'mcp:setup:supadata')
      .text('Apify', 'mcp:setup:apify')
      .row()
      .text('« Назад', 'mcp:folder:workspace'),
  };
}
