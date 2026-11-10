/**
 * Old INSTALL_SKILL protocol: model instruction, payload validation and file bytes.
 * [Runner](../agent/turn.mjs) adds the instruction; [processor](response-markers.mjs) validates final text before [writer](install-writer.mjs).
 * [Checks](../../tests/skills-install.test.mjs), [old contract](../../tests/reference/parity-skills-contract.txt).
 */
export const SKILL_BLOCK=/\[INSTALL_SKILL\]([\s\S]*?)\[\/INSTALL_SKILL\]/;
export const SKILL_BLOCKS=/\[INSTALL_SKILL\][\s\S]*?\[\/INSTALL_SKILL\]/g;
export const INVALID_SKILL='Не понял описание навыка — назови имя латиницей, короткое описание и текст навыка.';
export const SKILL_WRITE_FAILED='Не получилось сохранить навык — попробуй ещё раз.';
export function skillInstallPrompt(target) {
  if(!['claude','codex','oc'].includes(target?.providerId))return '';
  return `## Навыки
Ставить навык ты можешь ТОЛЬКО маркером: папку навыков не трогай.
Навык: [INSTALL_SKILL]{"name":"имя-латиницей","description":"одна строка, когда применять","body":"текст навыка в markdown"}[/INSTALL_SKILL]
Бот исполнит маркер и подставит результат вместо него. Успех словами НЕ обещай до результата, его подставит бот.
Если дана ссылка на навык — скачай текст через WebFetch и положи его в поле body.
Уже установленные навыки работают сами.`;
}
export function parseSkillPayload(text) {
  let data;try{data=JSON.parse(text);}catch{return null;}
  if(!data || typeof data!=='object' || Array.isArray(data))return null;
  const name=typeof data.name==='string'?data.name.trim().toLowerCase():'';
  const description=typeof data.description==='string'?data.description.trim():'';
  const body=typeof data.body==='string'?data.body.trim():'';
  return /^[a-z0-9][a-z0-9-]{1,48}$/.test(name) && description && description.length<=200 && body && body.length<=60000?{name,description,body}:null;
}
export function formatSkillFile(skill) {
  // Native YAML must preserve old accepted text, including backslashes/control units.
  const description=JSON.stringify(skill.description.replace(/\s+/g,' ').toWellFormed())
    .replace(/[\u007f-\u009f\ufffe\uffff]/g,character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
  return '---\nname: '+skill.name+'\ndescription: '+description+'\n---\n\n'+skill.body+'\n';
}
