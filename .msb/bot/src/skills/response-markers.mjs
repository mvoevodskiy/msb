/**
 * Returned model text -> old INSTALL_SKILL execution/result text before plan/delivery/history.
 * [Telegram worker](../telegram/bot.mjs) owns abort/finish; read-only [views](../telegram/view-delivery.mjs) never call this.
 * [Payload](install-protocol.mjs), [writer](install-writer.mjs), [checks](../../tests/skills-install.test.mjs).
 * Background/OC partial-error reachability is not inferred from this helper.
 */
import {SKILL_BLOCK,SKILL_BLOCKS,INVALID_SKILL,SKILL_WRITE_FAILED,parseSkillPayload} from './install-protocol.mjs';
import {writeInstalledSkill} from './install-writer.mjs';
export async function processSkillMarkers(text,target,{env=process.env,signal,write=writeInstalledSkill}={}) {
  if(typeof text!=='string' || !text.includes('[INSTALL_SKILL]'))return text;
  signal?.throwIfAborted();
  const first=SKILL_BLOCK.exec(text);if(!first)return text.trim();
  if(env.SKILL_INSTALL_ENABLED==='0')return text.replace(SKILL_BLOCKS,'').trim();
  const skill = parseSkillPayload(first[1].trim());
  let message = INVALID_SKILL;
  // Codex 0.166 validates description after Rust split_whitespace (including NEL).
  const hasNativeDescription = skill && (
    target?.providerId !== 'codex' || /\P{White_Space}/u.test(skill.description)
  );
  if (hasNativeDescription) {
    try {
      const result=await write(skill,target,{signal});signal?.throwIfAborted();
      message=`${result.replaced?'Обновил навык':'Поставил навык'} «${skill.name}»${result.written.length>1?' на обоих движках':''}. Заработает со следующего сообщения.`;
    } catch(error) {if(signal?.aborted)throw error;message=SKILL_WRITE_FAILED;}
  }
  return text.replace(SKILL_BLOCK,()=>message).replace(SKILL_BLOCKS,'').trim();
}
