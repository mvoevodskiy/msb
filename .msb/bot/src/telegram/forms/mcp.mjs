/**
 * Old one-shot token form. Only the current bot's env and captured provider can change.
 * [Arm callback](../routes/workspace.mjs), [state writer](../../mcp/managed.mjs),
 * [ingress checks](../../../tests/mcp-setup.test.mjs).
 */
import {loadState} from '../../state.mjs';
import {statePath} from '../../paths.mjs';
import {mcpTemplate} from '../../../shared/mcp-templates.mjs';
import {codexManagedMcpName} from '../../../shared/codex-mcp-name.mjs';
import {mcpCatalog,selectedMcpProvider} from '../../mcp/catalog.mjs';
import {enrollMcpTemplate} from '../../mcp/managed.mjs';
import {setupOpenClawTemplate} from '../../mcp/openclaw-setup.mjs';
import {visibleNativeMcp} from '../../mcp/native-removal.mjs';

const changed='Движок изменился. Открой /start → 🔌 MCP и попробуй ещё раз.';
const html={parse_mode:'HTML'};

export async function handleMcpInput({ctx,text,pending,chatId}) {
  const draft=pending.payload(chatId);
  pending.delete(chatId);
  const template=mcpTemplate(draft?.name);
  if(!template)return;
  const value=text.trim();
  if(!value.startsWith(template.prefix)) {
    const intro=template.name==='supadata'?'Ключ Supadata':'Токен Apify';
    await ctx.reply(`${intro} должен начинаться с <code>${template.prefix}</code>. Попробуй ещё раз через /start → 🔌 MCP.`,html);
    return;
  }
  if(/\s/.test(value)) {
    await ctx.reply('Ключ не должен содержать пробелов или переносов. Скопируй его целиком и пришли ещё раз.',html);
    return;
  }
  try{await ctx.api.deleteMessage(chatId,ctx.message.message_id);}catch{/* best effort */}
  const {state}=await loadState();
  if(draft.root!==statePath() || selectedMcpProvider(state)!==draft.provider){
    await ctx.reply(changed);
    return;
  }

  if(draft.provider==='oc'){
    const result=await setupOpenClawTemplate({template,value,profile:draft.profile});
    if(result.providerChanged)await ctx.reply(changed);
    else if(result.ok)await ctx.reply('✔ <b>'+template.name+'</b> подключён. Ключ сохранён — можно отправлять задачу.',html);
    else if(result.keySaved)await ctx.reply('✔ Ключ <b>'+template.name+'</b> сохранён.\n\n⚠️ Быстрые инструменты подключить не удалось. Можно повторить позже через /start → 🔌 MCP.',html);
    else await ctx.reply('❌ Ошибка подключения. Проверь настройки бота и попробуй ещё раз.');
    return;
  }

  const catalog=await mcpCatalog(state,{readProvider:draft.readProvider});
  if(!catalog){
    await ctx.reply('❌ Не удалось прочитать настройки MCP выбранного движка.');
    return;
  }
  const nativeName=draft.provider==='codex'?codexManagedMcpName(template.name):template.name;
  const reserved=nativeName!==template.name && catalog.entries.some(row=>row.name===nativeName);
  if(reserved || visibleNativeMcp(catalog,state).entries.some(row=>row.name===template.name)){
    await ctx.reply('Этот сервер уже настроен в профиле выбранного движка.');
    return;
  }
  const result=await enrollMcpTemplate({provider:draft.provider,name:template.name,value});
  if(result.providerChanged)await ctx.reply(changed);
  else if(result.ok)await ctx.reply(`✔ <b>${template.name}</b> подключён. Ключ сохранён — можно отправлять задачу.`,html);
  else if(result.keySaved)await ctx.reply('❌ Не удалось сохранить подключение MCP. Ключ сохранён.');
  else await ctx.reply('❌ Ошибка подключения. Проверь настройки бота и попробуй ещё раз.');
}
