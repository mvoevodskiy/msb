import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Queued cases still observe the unresolved fb5026f boundary; initial-pause cases check the new policy.
// [Old source and outcome](./parity-owner-spend-contract.txt).
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const moduleUrl = name => pathToFileURL(path.join(repo, name)).href;
mock.module(moduleUrl('.msb/bot/src/autonomy/openclaw-reminder-dispatch.mjs'), {
  namedExports: { createOpenClawReminderDispatcher: () => async () => {} },
});
const { startScheduler } = await import(moduleUrl('.msb/bot/src/autonomy/scheduler.mjs'));
const { botRoot } = await import(moduleUrl('.msb/bot/src/paths.mjs'));
const { loadState, saveState } = await import(moduleUrl('.msb/bot/src/state.mjs'));
const { fixture } = await import(moduleUrl('.msb/bot/tests/helpers/menu-fixture.mjs'));
const instant = Date.parse('2026-10-25T03:30:00.000Z');
const timer = { id: 'once', name: 'fixture', prompt: 'fixture timer', enabled: true,
  type: 'once', at: '2026-10-25T03:20:00.000Z' };
async function until(fn) {
  for (let count=0;count<1000;count++) { if (fn()) return; await new Promise(resolve=>setTimeout(resolve,5)); }
  assert.fail('fixture wait timed out');
}
for (const provider of ['codex', 'claude']) {
  test('observe queued legacy timer while spend paused: ' + provider, async t => {
    let release;
    const held = new Promise(resolve => { release=resolve; });
    t.after(release);
    const calls=[];
    const f = await fixture(t, async args => { calls.push(args); if(args.prompt==='hold') await held; return {ok:true,text:'fixture result'}; },
      { overlay:false, runtimeProfile:'jar1' });
    for (const key of ['MSB_SESSION_DIR','IIA_SESSION_DIR','AUTONOMY_DIR']) delete process.env[key];
    const current=(await loadState()).state;
    const state={...current, chatId:42, userId:42, timezone:'UTC'};
    if(provider==='claude') { delete state.extAuthBypass; state.authMode='subscription'; state.hasSubscriptionAuth=true; }
    await saveState(state);
    const file=path.join(botRoot(),'schedules.json');
    await fs.writeFile(file,JSON.stringify([timer]));
    const scheduler=startScheduler({api:f.bot.api,adminId:42,timezone:'UTC',now:()=>instant,log(){},
      scheduledTurns:f.bot[Symbol.for('msb.scheduledTurns')],runTurn:async()=>assert.fail('unexpected interval')});
    t.after(()=>scheduler.stop());
    await f.message('hold');
    await until(()=>calls.length===1);
    await scheduler.tickNow();
    assert.equal(JSON.parse(await fs.readFile(file,'utf8'))[0].lastRunAt,new Date(instant).toISOString());
    await saveState({...((await loadState()).state),costPaused:true});
    release();
    await until(()=>f.messages.some(text=>text.includes('Дневной лимит')));
    assert.equal(calls.length,1);
    const [saved]=JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(saved.enabled,false);
    assert.equal(saved.legacyPendingRun,undefined);
    await f.callback('settings:cost:resume');
    await scheduler.tickNow();
    assert.equal(calls.length,1);
  });
}


for (const provider of ['codex', 'claude']) {
  test('initially paused legacy timer stays pending until resume: ' + provider, async t => {
    const calls = [];
    const f = await fixture(t, async args => { calls.push(args); return {ok:true,text:'fixture result'}; },
      { overlay:false, runtimeProfile:'jar1' });
    for (const key of ['MSB_SESSION_DIR','IIA_SESSION_DIR','AUTONOMY_DIR']) delete process.env[key];
    const state={...((await loadState()).state), chatId:42, userId:42, timezone:'UTC', costPaused:true};
    if(provider==='claude') { delete state.extAuthBypass; state.authMode='subscription'; state.hasSubscriptionAuth=true; }
    await saveState(state);
    const file=path.join(botRoot(),'schedules.json');
    await fs.writeFile(file,JSON.stringify([timer]));
    const scheduler=startScheduler({api:f.bot.api,adminId:42,timezone:'UTC',now:()=>instant,log(){},
      scheduledTurns:f.bot[Symbol.for('msb.scheduledTurns')],runTurn:async()=>assert.fail('unexpected interval')});
    t.after(()=>scheduler.stop());
    await scheduler.tickNow();
    await until(()=>f.messages.some(text=>text.includes('Дневной лимит')));
    assert.equal(calls.length,0);
    const [saved]=JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(saved.enabled,false);
    assert.equal(saved.lastRunAt,new Date(instant).toISOString());
    assert.equal(saved.legacyPendingRun?.reason,'cost_pause');
    await f.callback('settings:cost:resume');
    await scheduler.tickNow();
    await until(()=>calls.length===1);
    await scheduler.tickNow();
    assert.equal(calls.length,1);
  });
}
