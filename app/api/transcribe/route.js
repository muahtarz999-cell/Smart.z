import { json } from '../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';

export const runtime = 'edge';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' };

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    console.error('[Transcribe] GROQ_API_KEY is not set');
    return json({ error: true, code: 'NOT_CONFIGURED', message: 'خدمة تحويل الصوت إلى نص غير مضبوطة.' }, 503);
  }

  let audio;
  try {
    audio = (await request.formData()).get('audio');
  } catch {
    return json({ error: true, code: 'BAD_REQUEST', message: 'لم يصل ملف الصوت.' }, 400);
  }
  if (!audio || typeof audio === 'string' || !audio.size) {
    return json({ error: true, code: 'NO_AUDIO', message: 'لم يصل ملف الصوت.' }, 400);
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return json({ error: true, code: 'TOO_LARGE', message: 'التسجيل أطول من المسموح.' }, 413);
  }

  // Whisper identifies the format from the file name, so it must match the real type.
  const type = String(audio.type || 'audio/wav').split(';')[0];
  const upstream = new FormData();
  upstream.append('file', audio, `audio.${EXTENSIONS[type] || 'wav'}`);
  upstream.append('model', 'whisper-large-v3');
  upstream.append('language', 'ar');
  upstream.append('response_format', 'json');

  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqApiKey}` },
      body: upstream,
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    return json({ error: true, code: 'UPSTREAM_TIMEOUT', message: 'تأخرت خدمة تحويل الصوت. أعد المحاولة.' }, 504);
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    console.error('[Transcribe] Groq error', { status: response.status, message: detail?.error?.message });
    const code = response.status === 401 || response.status === 403 ? 'UPSTREAM_AUTH'
      : response.status === 429 ? 'UPSTREAM_RATE_LIMIT' : 'UPSTREAM_ERROR';
    const message = code === 'UPSTREAM_AUTH' ? 'مفتاح خدمة تحويل الصوت غير صالح.'
      : code === 'UPSTREAM_RATE_LIMIT' ? 'تم تجاوز حد الاستخدام مؤقتاً. أعد المحاولة بعد قليل.'
        : 'تعذر تحويل الصوت إلى نص.';
    // 502 for every upstream problem, so the app never mistakes it for an expired login (401).
    return json({ error: true, code, message }, 502);
  }

  const result = await response.json().catch(() => ({}));
  return json({ text: typeof result.text === 'string' ? result.text.trim() : '' });
}
