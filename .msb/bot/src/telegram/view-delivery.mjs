/**
 * Prepared HTML view -> ordered Telegram parts; no model formatting/markers/footer.
 * Short views stay byte-exact. Reuses the [response splitter](./response.mjs).
 * Callers own transport/render ordering: [router](./router.mjs), [skills command](./bot.mjs).
 * [Checks](../../tests/view-delivery.test.mjs), [OC ingress](../../tests/skills-openclaw.test.mjs).
 */
import {splitHtml,visibleHtmlLength} from './response.mjs';
const LIMIT=4096;
export async function deliverView(view,{edit,reply,scope}={}) {
  const text=String(view.text).toWellFormed();
  const chunks=visibleHtmlLength(text)<=LIMIT?[text]:splitHtml(text,LIMIT,{keepInlineCode:true});
  let result;
  for(let index=0;index<chunks.length;index++) {
    if(scope && !scope.isCurrent())break;
    const part={...view,text:chunks[index],keyboard:index===chunks.length-1?view.keyboard:{inline_keyboard:[]}};
    result=await(index===0 && edit?edit(part):reply(part));
  }
  return result;
}
