/**
 * Bounded UTF16 descriptions without splitting astral characters; no I/O.
 * [Ledger](../sessions/ledger.mjs) keeps the old200 bound; [session text](../telegram/screens/session-list-text.mjs)
 * adds ellipses only for display. [Checks](../../tests/session-list-size.test.mjs).
 */
export function clipUtf16(value,limit) {
  const text=String(value ?? '').toWellFormed();
  if(limit===Infinity)return text;
  if(!Number.isInteger(limit) || limit<0)throw new RangeError('Invalid text limit');
  const clipped=text.slice(0,limit),last=clipped.charCodeAt(clipped.length-1);
  return last>=0xd800 && last<=0xdbff?clipped.slice(0,-1):clipped;
}
