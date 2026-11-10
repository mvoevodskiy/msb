/**
 * Old MG labels/configuration metadata; no API health or backend availability claim.
 * Input: current env → key/label/status, never values. Deepgram lookup belongs to
 * [STT](../media/stt.mjs); all other rows describe process env presence only.
 * Caller/renderer: [prompt](./prompt.mjs). [Contract](../../tests/reference/parity-env-services-contract.txt),
 * [checks](../../tests/env-services.test.mjs). Does not load values into process env.
 */
import profile from '../../shared/profile.cjs';
import {resolveSttConfig} from '../media/stt.mjs';

// Old master00f081f, readableblob73aa9e7 lines9156–9245. Labels/hint flags,
// not old recipes or unsupported claims about built-in tools and pipelines.
const SERVICES=[
 ['DEEPGRAM_API_KEY','Голосовые сообщения (Deepgram)',true],
 ['VOYAGE_API_KEY','Семантический поиск (Voyage AI)',true],
 ['OPENROUTER_API_KEY','OpenRouter (мультимодель)',true],
 ['GITHUB_TOKEN','GitHub',true],
 ['SERPER_API_KEY','Веб-поиск Serper',true],
 ['BRAVE_API_KEY','Веб-поиск Brave',true],
 ['SUPABASE_URL','Supabase (БД)',true],
 ['SUPABASE_ACCESS_TOKEN','Supabase CLI',false],
 ['VERCEL_TOKEN','Vercel (деплой)',true],
 ['RAILWAY_TOKEN','Railway (деплой)',true],
 ['GOOGLE_API_KEY','Google AI (Gemini)',false],
 ['GEMINI_API_KEY','Google Gemini',false],
 ['OPENAI_API_KEY','OpenAI (GPT)',false],
 ['REPLICATE_API_TOKEN','Replicate',false],
 ['CLOUDFLARE_API_TOKEN','Cloudflare',false],
 ['NANOBANANA_API_KEY','NanoBanana',false],
 ['FAL_KEY','fal.ai (генеративное медиа)',true],
 ['SUPADATA_API_KEY','Supadata (видео и веб)',true],
 ['APIFY_API_KEY','Apify (соцсети и данные)',true],
];
export const ENV_SERVICE_KEYS=new Set(SERVICES.map(([key])=>key));

export async function envServiceMetadata(env = process.env) {
  let deepgram;
  try {
    deepgram = (await resolveSttConfig(env)).apiKey ? 'configured' : 'unset';
  } catch (error) {
    deepgram = error?.code === 'STT_NOT_CONFIGURED' ? 'unset' : 'unknown';
  }
  return SERVICES.map(([key, label, hint]) => ({
    key, label, hint,
    source: key === 'DEEPGRAM_API_KEY' ? 'настройках STT' : 'окружении процесса',
    status: key === 'DEEPGRAM_API_KEY' ? deepgram : profile.envValue(env, key) ? 'configured' : 'unset',
  }));
}
