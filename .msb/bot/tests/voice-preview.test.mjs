import test from 'node:test';
import assert from 'node:assert/strict';
import { voicePreview, STT_ONBOARDING } from '../src/telegram/voice.mjs';

test('voice preview retains the original quote/wave, full 300 limit and literal HTML', () => {
  const wave = '\n🎙 •~•~•~•~•~•~•~•~•~•~•';
  assert.deepEqual(voicePreview('<b>&'), { html: '<blockquote>&lt;b&gt;&amp;</blockquote>' + wave, plain: '<b>&' + wave });
  assert.equal(voicePreview('x'.repeat(300)).plain, 'x'.repeat(300) + wave);
  assert.equal(voicePreview('x'.repeat(301)).plain, 'x'.repeat(300) + '...' + wave);
  const preview = voicePreview('x'.repeat(299) + '😀tail');
  assert.ok(preview.html.isWellFormed());
  assert.equal(preview.plain, 'x'.repeat(299) + '...' + wave);
});

test('missing STT keeps the original setup and skip routes', () => {
  assert.deepEqual(STT_ONBOARDING.reply_markup.inline_keyboard.flat().map(x => x.callback_data),
    ['settings:env:quick:DEEPGRAM_API_KEY', 'whisper:skip']);
  assert.ok(STT_ONBOARDING.text.startsWith('🎙 Голосовые пока не настроены.'));
});
