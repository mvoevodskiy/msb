import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareIntroductionSummary } from '../intro-summary-policy.mjs';
import { buildCodexExecArgs, runCodexTurn } from '../adapters/codex.mjs';

const initial = { command: '/bin/codex', cwd: '/tmp/work', env: { HOME: '/tmp' }, schemaFile: '/tmp/schema.json' };
test('summary masks every native MCP server and disables non-summary tools', async () => {
  let captured;
  const read = async (method, options) => { captured = { method, options }; return { ok: true, data: { config: {
    mcp_servers: { 'one': { command: '/bin/example' }, 'other.name': { enabled: false } },
  } } }; };
  const r = await prepareIntroductionSummary({ ...initial, read });
  assert.equal(r.ok, true);
  assert.equal(captured.method, 'config/read');
  assert.equal(captured.options.ownProcessGroup, false);
  assert.equal(r.args.at(-1), 'mcp_servers={"one"={enabled=false},"other.name"={enabled=false}}');
  for (const name of ['apps','plugins','remote_plugin','hooks','shell_tool','shell_snapshot','unified_exec',
    'browser_use','computer_use','code_mode','goals','image_generation','view_image','memories','multi_agent','enable_mcp_apps']) {
    assert.ok(r.args.some((x,i) => x === '--disable' && r.args[i+1] === name));
  }
  for (const name of ['apps','plugins','remote_plugin','hooks']) {
    assert.ok(captured.options.appArgs.some((x,i) => x === '--disable' && captured.options.appArgs[i+1] === name));
  }
  assert.ok(r.args.includes('web_search="disabled"'));
  assert.ok(r.args.includes('/tmp/schema.json'));
  const argv = buildCodexExecArgs({ model: 'fixture-model', effort: 'max', resumeId: 'valid-thread',
    forceHttp: false, summaryArgs: r.args });
  assert.deepEqual(argv.slice(0,4), ['exec','--json','--sandbox','read-only']);
  assert.ok(!argv.includes('danger-full-access'));
  assert.ok(argv.includes('--output-schema'));
  assert.equal(argv[argv.indexOf('resume')+1], 'valid-thread');
});

test('production adapter forwards the restricted policy to the resumed native process', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-intro-policy-'));
  t.after(() => fs.rm(home, {recursive:true, force:true}));
  const cwd = path.join(home, 'workspace'), profile = path.join(home, 'codex'), bin = path.join(home, 'bin');
  await Promise.all([cwd, profile, bin].map(dir => fs.mkdir(dir, {recursive:true})));
  const trace = path.join(home, 'exec.json');
  const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
  const schema = path.join(home, 'schema.json');
  const original = 'model = "fixture-model"\nmodel_reasoning_effort = "high"\n';
  await fs.writeFile(path.join(profile, 'auth.json'), '{"tokens":{"access_token":"fixture"}}');
  await fs.writeFile(path.join(profile, 'config.toml'), original);
  await fs.writeFile(schema, '{}');
  const fake = '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv[2] === 'app-server') {
  readline.createInterface({input: process.stdin}).on('line', line => {
    const req = JSON.parse(line);
    if (req.id === 1) process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
    if (req.id === 2) process.stdout.write(JSON.stringify({id:2,result:{config:{mcp_servers:{fixture:{command:'unused'}}}}})+'\\n');
  });
} else {
  fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({args:process.argv.slice(2),
    mcp:process.env.MSB_TURN_MCP_CUSTOM}));
  process.stdin.resume();
  process.stdin.once('end', () => {
    for (const event of [{type:'thread.started',thread_id:${JSON.stringify(thread)}},
      {type:'item.completed',item:{type:'agent_message',text:'{"version":1,"save":false,"user":[],"memory":[]}'}},
      {type:'turn.completed'}]) console.log(JSON.stringify(event));
  });
}`;
  await fs.writeFile(path.join(bin, 'codex'), fake, {mode:0o755});
  const env = {HOME:home, CODEX_HOME:profile, PATH:bin, MSB_CODEX_INTRO_SUMMARY:'1',
    MSB_CODEX_INTRO_SCHEMA:schema, MSB_TURN_MCP_CUSTOM:'must-not-be-forwarded'};
  const result = await runCodexTurn({prompt:'summary', cwd, env, home, parsed:{resume:'ext:codex:'+thread}});
  assert.equal(result.ok, true);
  assert.equal(result.nativeSessionId, thread);
  const call = JSON.parse(await fs.readFile(trace, 'utf8'));
  assert.equal(call.args[call.args.indexOf('--sandbox')+1], 'read-only');
  assert.equal(call.args[call.args.indexOf('--output-schema')+1], schema);
  assert.equal(call.args[call.args.indexOf('resume')+1], thread);
  assert.ok(call.args.includes('mcp_servers={"fixture"={enabled=false}}'));
  assert.equal(call.mcp, undefined);
  assert.equal(await fs.readFile(path.join(profile, 'config.toml'), 'utf8'), original);
  await fs.unlink(trace);
  assert.equal((await runCodexTurn({prompt:'summary', cwd, env, home, parsed:{}})).ok, false);
  await assert.rejects(fs.stat(trace), {code:'ENOENT'});
});
test('summary policy refuses unreadable or malformed config and relative scope', async () => {
  const bad = [async()=>{throw Error('unavailable')}, async()=>({ok:false}), async()=>({ok:true,data:{config:[]}}),
    async()=>({ok:true,data:{config:{mcp_servers:[]}}})];
  for (const read of bad) assert.equal((await prepareIntroductionSummary({ ...initial, read })).ok, false);
  assert.equal((await prepareIntroductionSummary({ ...initial, cwd: 'relative', read: async()=>{ throw Error('unexpected'); } })).ok, false);
  assert.equal((await prepareIntroductionSummary({ ...initial, schemaFile: 'relative', read: async()=>{ throw Error('unexpected'); } })).ok, false);
});
