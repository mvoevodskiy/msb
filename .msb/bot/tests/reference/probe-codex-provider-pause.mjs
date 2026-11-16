/**
 * Regression for the in-flight Claude → Codex interval pause race.
 * The original RED reproduction remains in commit 1f3f756. The test child
 * uses temporary files and fake Telegram/CLI/model; unrelated status is mocked.
 * Run: node .msb/bot/tests/reference/probe-codex-provider-pause.mjs
 */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const testFile=fileURLToPath(new URL('../interval-provider-pause.test.mjs',import.meta.url));
const child=spawnSync(process.execPath,['--test','--test-reporter=spec',testFile],{
  env:{PATH:'/usr/bin:/bin',TMPDIR:process.env.TMPDIR||'/tmp'},stdio:'inherit',timeout:20000,
});
if(child.error)throw child.error;
if(child.status!==0)process.exit(child.status??1);
console.log('PASS: the in-flight Codex selection defers the interval until wake.');
