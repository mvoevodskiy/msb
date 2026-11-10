/**
 * Old OC eligible JSON list; one owned readonly CLI, no engine/service/auth mutation.
 * [Catalog](./catalog.mjs), [views](../telegram/screens/openclaw-skills.mjs),
 * [production contract checks](../../tests/skills-openclaw.test.mjs).
 */
import {readOpenClawOutput} from '../agent/openclaw-read.mjs';
export function parseOpenClawSkills(text) {
  let parsed;try{parsed=JSON.parse(text);}catch{return [];}
  const rows=Array.isArray(parsed)?parsed:parsed?.skills ?? parsed?.eligible ?? parsed?.items;
  if(!Array.isArray(rows))return [];
  return rows.filter(row=>row && typeof row==='object').flatMap(row=>{
    const name=String(row.name ?? '').trim();
    return name?[{name,description:String(row.description ?? '').trim(),source:String(row.source ?? '').trim(),userInvocable:row.userInvocable!==false}]:[];
  });
}

export async function readOpenClawSkills(options) {
  const text=await readOpenClawOutput(['skills','list','--json','--eligible'],options);
  return parseOpenClawSkills(text);
}
