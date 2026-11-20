/**
 * Old monitor GitHub duplicate/re-enable parity: blob 73aa9e7e,
 * git show <blob> | nl -ba, DHA 5756–5785, OQA 43265–43278.
 * Fake Telegram and temporary profile; no network or production data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/menu-fixture.mjs';
import { addSourceFromInput, loadMonitorConfig, saveMonitorConfig } from '../src/monitor/config.mjs';

async function prepared(t, {enabled=false, group=true}={}) {
  const f = await fixture(t, undefined, {overlay:false});
  const cfg = await loadMonitorConfig();
  cfg.github.enabled=group;
  cfg.github.repos=[{owner:'ExampleOrg',repo:'MyRepo',name:'ExampleOrg/MyRepo',enabled,track:['releases'],marker:'preserve'},
    {owner:'Other',repo:'Repo',enabled:false,marker:'untouched'}];
  cfg.telegram.channels=[{username:'fixture',enabled:false,marker:'another-provider'}];
  await saveMonitorConfig(cfg);
  return {f,before:cfg};
}

test('adding a disabled GitHub source with different case re-enables only that record and reports it', async t => {
  const {f,before}=await prepared(t);
  await f.callback('mon:add-hint'); await f.message('https://github.com/exampleorg/myrepo');
  const after=await loadMonitorConfig();
  assert.deepEqual(after.github.repos[0],{...before.github.repos[0],enabled:true});
  assert.deepEqual(after.github.repos[1],before.github.repos[1]);
  assert.deepEqual(after.telegram,before.telegram);
  assert.equal(after.github.repos.length,2);
  assert.equal(f.messages.at(-1),'✅ GitHub: exampleorg/myrepo (re-enabled)');
});

test('case-insensitive active duplicate is not added or changed', async t => {
  const {before}=await prepared(t,{enabled:true});
  const out=await addSourceFromInput('https://github.com/exampleorg/MYREPO');
  assert.equal(out.added,false);
  assert.deepEqual((await loadMonitorConfig()).github,before.github);
});

test('concurrent case variants re-enable only once and leave an independently disabled service disabled', async t => {
  const {before}=await prepared(t,{group:false});
  const results=await Promise.all([addSourceFromInput('https://github.com/exampleorg/myrepo'),
    addSourceFromInput('https://github.com/EXAMPLEORG/MYREPO')]);
  assert.equal(results.filter(x=>x.reason==='re-enabled').length,1);
  assert.equal(results.filter(x=>x.added===false).length,1);
  const after=await loadMonitorConfig();
  assert.equal(after.github.enabled,false);
  assert.deepEqual(after.github.repos[0],{...before.github.repos[0],enabled:true});
  assert.equal(after.github.repos.length,2);
  assert.deepEqual(after.github.repos[1],before.github.repos[1]);
});

test('a record without enabled is already active in open-core and remains unchanged', async t => {
  await prepared(t);
  const cfg=await loadMonitorConfig(); delete cfg.github.repos[0].enabled;
  await saveMonitorConfig(cfg);
  const result=await addSourceFromInput('https://github.com/exampleorg/myrepo');
  assert.equal(result.added,false);
  assert.equal(Object.hasOwn((await loadMonitorConfig()).github.repos[0],'enabled'),false);
});


for (const secondEnabled of [false, true]) {
  test(`pre-existing case variants report ambiguity and keep both records when second enabled is ${secondEnabled}`, async t => {
    const {f}=await prepared(t);
    const cfg=await loadMonitorConfig();
    cfg.github.repos.push({owner:'EXAMPLEORG',repo:'MYREPO',enabled:secondEnabled,marker:'existing-duplicate'});
    await saveMonitorConfig(cfg);
    await f.callback('mon:add-hint');
    await f.message('https://github.com/exampleorg/myrepo');
    assert.equal(f.messages.at(-1),'Найдено несколько записей GitHub для exampleorg/myrepo. Проверь список источников.');
    assert.deepEqual((await loadMonitorConfig()).github,cfg.github);
  });
}
