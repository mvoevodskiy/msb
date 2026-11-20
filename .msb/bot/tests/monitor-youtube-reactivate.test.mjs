/**
 * Old monitor YouTube source handling: blob 73aa9e7e,
 * git show <blob> | nl -ba, VHA 5684–5711, OQA 43245–43260.
 * Fake Telegram and temporary profile; no network or production data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/menu-fixture.mjs';
import { addSourceFromInput, loadMonitorConfig, saveMonitorConfig } from '../src/monitor/config.mjs';

const firstId = `UC${'a'.repeat(22)}`;
const targetId = `UC${'b'.repeat(22)}`;
const newId = `UC${'c'.repeat(22)}`;

async function prepared(t) {
  const f = await fixture(t, undefined, {overlay:false});
  const cfg = await loadMonitorConfig();
  cfg.youtube.enabled = false;
  // The old VHA format has no handle field.
  cfg.youtube.channels = [
    {channelId:firstId,name:'first fixture',enabled:false,marker:'untouched'},
    {channelId:targetId,name:'target fixture',enabled:false,marker:'preserve'},
  ];
  cfg.twitter.accounts = [{username:'untouched',enabled:false}];
  await saveMonitorConfig(cfg);
  return {f,before:cfg};
}

test('adding an existing ID re-enables the intended old-shaped channel and reports it', async t => {
  const {f,before}=await prepared(t);
  await f.callback('mon:add-hint');
  await f.message(`https://youtube.com/channel/${targetId}`);
  const after=await loadMonitorConfig();
  assert.deepEqual(after.youtube.channels[0],before.youtube.channels[0]);
  assert.deepEqual(after.youtube.channels[1],{...before.youtube.channels[1],enabled:true});
  assert.equal(after.youtube.enabled,false);
  assert.deepEqual(after.twitter,before.twitter);
  assert.equal(f.messages.at(-1),'✅ YouTube: target fixture (re-enabled)');
});

test('adding a new channel ID does not match a different old-shaped channel missing handle', async t => {
  const {before}=await prepared(t);
  const result=await addSourceFromInput(`https://youtube.com/channel/${newId}`);
  const after=await loadMonitorConfig();
  assert.equal(result.added,true);
  assert.deepEqual(after.youtube.channels.slice(0,2),before.youtube.channels);
  assert.equal(after.youtube.channels.length,3);
  assert.equal(after.youtube.channels[2].channelId,newId);
  assert.equal(after.youtube.enabled,true);
});

test('a channel with no enabled field is already active and remains unchanged', async t => {
  await prepared(t);
  const cfg=await loadMonitorConfig();
  cfg.youtube.channels.shift();
  delete cfg.youtube.channels[0].enabled;
  await saveMonitorConfig(cfg);
  const result=await addSourceFromInput(`https://youtube.com/channel/${targetId}`);
  assert.equal(result.added,false);
  assert.deepEqual((await loadMonitorConfig()).youtube,cfg.youtube);
});

test('an existing handle remains addressable and re-enables only its own source', async t => {
  const {before}=await prepared(t);
  const cfg=await loadMonitorConfig();
  cfg.youtube.channels.push({channelId:null,handle:'science',name:'science',enabled:false,marker:'handle'});
  await saveMonitorConfig(cfg);
  const result=await addSourceFromInput('https://youtube.com/@science');
  const after=await loadMonitorConfig();
  assert.equal(result.reason,'re-enabled');
  assert.deepEqual(after.youtube.channels.slice(0,2),before.youtube.channels);
  assert.deepEqual(after.youtube.channels[2],{...cfg.youtube.channels[2],enabled:true});
});

test('concurrent requests for the same ID re-enable once under the existing lock', async t => {
  const {before}=await prepared(t);
  const results=await Promise.all([
    addSourceFromInput(`https://youtube.com/channel/${targetId}`),
    addSourceFromInput(`https://youtube.com/channel/${targetId}`),
  ]);
  assert.equal(results.filter(x=>x.reason==='re-enabled').length,1);
  assert.equal(results.filter(x=>x.added===false).length,1);
  const after=await loadMonitorConfig();
  assert.deepEqual(after.youtube.channels[0],before.youtube.channels[0]);
  assert.deepEqual(after.youtube.channels[1],{...before.youtube.channels[1],enabled:true});
});

test('a display name equal to another channel ID cannot identify that other channel', async t => {
  await prepared(t);
  const cfg=await loadMonitorConfig();
  cfg.youtube.channels[0].name=newId;
  await saveMonitorConfig(cfg);
  const result=await addSourceFromInput(`https://youtube.com/channel/${newId}`);
  const after=await loadMonitorConfig();
  assert.equal(result.added,true);
  assert.deepEqual(after.youtube.channels.slice(0,2),cfg.youtube.channels);
  assert.equal(after.youtube.channels[2].channelId,newId);
});

test('exact handle takes precedence over another channel with the same display name', async t => {
  await prepared(t);
  const cfg=await loadMonitorConfig();
  cfg.youtube.channels[0].name='science';
  cfg.youtube.channels.push({channelId:null,handle:'science',name:'science',enabled:false});
  await saveMonitorConfig(cfg);
  const result=await addSourceFromInput('https://youtube.com/@science');
  const after=await loadMonitorConfig();
  assert.equal(result.reason,'re-enabled');
  assert.deepEqual(after.youtube.channels.slice(0,2),cfg.youtube.channels.slice(0,2));
  assert.deepEqual(after.youtube.channels[2],{...cfg.youtube.channels[2],enabled:true});
});

test('multiple explicit ID matches are reported without changing either source', async t => {
  const {f}=await prepared(t);
  const cfg=await loadMonitorConfig();
  cfg.youtube.channels.push({channelId:targetId,name:'duplicate',enabled:true});
  await saveMonitorConfig(cfg);
  await f.callback('mon:add-hint');
  await f.message(`https://youtube.com/channel/${targetId}`);
  assert.equal(f.messages.at(-1),`Найдено несколько записей YouTube для ${targetId}. Проверь список источников.`);
  assert.deepEqual((await loadMonitorConfig()).youtube,cfg.youtube);
});

test('legacy name-only handle fallback remains available pending verified resolution', async t => {
  await prepared(t);
  const cfg=await loadMonitorConfig();
  cfg.youtube.channels[0].name='science';
  await saveMonitorConfig(cfg);
  const result=await addSourceFromInput('https://youtube.com/@science');
  const after=await loadMonitorConfig();
  assert.equal(result.reason,'re-enabled');
  assert.deepEqual(after.youtube.channels[0],{...cfg.youtube.channels[0],enabled:true});
  assert.deepEqual(after.youtube.channels[1],cfg.youtube.channels[1]);
  assert.equal(after.youtube.channels.length,2);
});

test('a handle and ID saved in the same resolved record match without another source', async t => {
  await prepared(t);
  const cfg=await loadMonitorConfig();
  cfg.youtube.channels.push({channelId:newId,handle:'science',name:'science',enabled:true});
  await saveMonitorConfig(cfg);
  const byId=await addSourceFromInput(`https://youtube.com/channel/${newId}`);
  const byHandle=await addSourceFromInput('https://youtube.com/@science');
  assert.equal(byId.added,false);
  assert.equal(byHandle.added,false);
  assert.deepEqual((await loadMonitorConfig()).youtube,cfg.youtube);
});

test('different ID and unresolved handle are not assumed to be the same channel', async t => {
  await prepared(t);
  const cfg=await loadMonitorConfig();
  cfg.youtube.channels.push({channelId:null,handle:'science',name:'science',enabled:true});
  await saveMonitorConfig(cfg);
  const result=await addSourceFromInput(`https://youtube.com/channel/${newId}`);
  const after=await loadMonitorConfig();
  assert.equal(result.added,true);
  assert.deepEqual(after.youtube.channels.slice(0,3),cfg.youtube.channels);
  assert.equal(after.youtube.channels[3].channelId,newId);
});

test('legacy handle-prefixed channel ID remains addressable without a handle field', async t => {
  await prepared(t);
  const cfg=await loadMonitorConfig();
  cfg.youtube.channels.push({channelId:'handle:science',name:'legacy',enabled:false});
  await saveMonitorConfig(cfg);
  const result=await addSourceFromInput('https://youtube.com/@science');
  assert.equal(result.reason,'re-enabled');
  const after=await loadMonitorConfig();
  assert.deepEqual(after.youtube.channels.slice(0,2),cfg.youtube.channels.slice(0,2));
  assert.deepEqual(after.youtube.channels[2],{...cfg.youtube.channels[2],enabled:true});
});

test('duplicate explicit handles are reported without changing either source', async t => {
  await prepared(t);
  const cfg=await loadMonitorConfig();
  cfg.youtube.channels.push({channelId:null,handle:'science',name:'first',enabled:false});
  cfg.youtube.channels.push({channelId:newId,handle:'science',name:'second',enabled:true});
  await saveMonitorConfig(cfg);
  const result=await addSourceFromInput('https://youtube.com/@science');
  assert.equal(result.ok,false);
  assert.match(result.error,/несколько записей YouTube/);
  assert.deepEqual((await loadMonitorConfig()).youtube,cfg.youtube);
});

test('a null enabled value remains active under the current poll semantics', async t => {
  await prepared(t);
  const cfg=await loadMonitorConfig();
  cfg.youtube.channels[1].enabled=null;
  await saveMonitorConfig(cfg);
  const result=await addSourceFromInput(`https://youtube.com/channel/${targetId}`);
  assert.equal(result.added,false);
  assert.deepEqual((await loadMonitorConfig()).youtube,cfg.youtube);
});
