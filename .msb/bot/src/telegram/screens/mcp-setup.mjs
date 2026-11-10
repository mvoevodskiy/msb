/**
 * Old template list and token prompts. Input lives in [MCP form](../forms/mcp.mjs).
 * [Callbacks](../routes/workspace.mjs), [ingress checks](../../../tests/mcp-setup.test.mjs).
 */
import {InlineKeyboard} from 'grammy';
import {BLANK} from './shared.mjs';
import {codexManagedMcpName} from '../../../shared/codex-mcp-name.mjs';

const descriptions={
  supadata:{
    label:'Supadata',
    body:'транскрипты видео, метадата, веб-скрейпинг\n  <a href="https://dash.supadata.ai">dash.supadata.ai</a> · free 100 запросов/мес, от $5/мес',
    prompt:'Отправь API ключ (начинается с <code>sd_</code>).\n\nПолучить: <a href="https://dash.supadata.ai">dash.supadata.ai</a> → зарегистрируйся → ключ в дашборде.',
  },
  apify:{
    label:'Apify',
    body:'23K+ скрейперов (YouTube, Instagram, TikTok, Twitter)\n  <a href="https://console.apify.com/settings/integrations">console.apify.com</a> · free $5/мес, от $19/мес',
    prompt:'Отправь API токен (начинается с <code>apify_api_</code>).\n\nПолучить: <a href="https://console.apify.com/settings/integrations">console.apify.com</a> → Settings → Integrations.',
  },
};

export function mcpAddScreen({entries=[],provider}={},nativeEntries=entries) {
  const installed=new Set(entries.map(row=>row.name));
  const nativeNames=new Set(nativeEntries.map(row=>row.name));
  const keyboard=new InlineKeyboard(),lines=[];
  for(const [name,{label,body}] of Object.entries(descriptions)){
    if(installed.has(name) || (provider==='codex' && nativeNames.has(codexManagedMcpName(name))))continue;
    lines.push(`[+] <b>${label}</b> — ${body}`);
    keyboard.text(label,'mcp:setup:'+name);
  }
  if(lines.length)keyboard.row();
  const description=lines.length?`Шаблоны:\n\n${lines.join('\n\n')}\n\nИли скажи агенту:`:'Шаблоны уже подключены.\n\nСкажи агенту:';
  return {
    text:`🔌 <b>Добавить MCP сервер</b>\n\n${description}\n&gt; <code>подключи MCP сервер [название]</code>\n${BLANK}`,
    keyboard:keyboard.text('« Назад',provider==='oc'?'menu:mcp':'mcp:folder:workspace'),
    disablePreview:true,
  };
}

export function mcpTemplatePrompt(name) {
  const {label,prompt}=descriptions[name];
  return {text:`🔌 <b>${label}</b>\n\n${prompt}\n${BLANK}`,disablePreview:true};
}
