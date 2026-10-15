/**
 * Speech-to-text with Groq Whisper (server only). Shared by the app's voice
 * turns (/api/transcribe) and incoming WhatsApp voice notes.
 */

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const EXTENSIONS = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/aac': 'm4a', 'audio/amr': 'amr',
};

export class TranscriptionError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** audio: Blob | Uint8Array, type: MIME. Returns the transcript (may be ''). */
export async function transcribeAudio(audio, type = 'audio/wav') {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new TranscriptionError('NOT_CONFIGURED', 'خدمة تحويل الصوت إلى نص غير مضبوطة.', 503);

  const mime = String(type || 'audio/wav').split(';')[0].trim().toLowerCase();
  const blob = audio instanceof Blob ? audio : new Blob([audio], { type: mime });
  if (!blob.size) throw new TranscriptionError('NO_AUDIO', 'لم يصل ملف الصوت.', 400);
  if (blob.size > MAX_AUDIO_BYTES) throw new TranscriptionError('TOO_LARGE', 'التسجيل أطول من المسموح.', 413);

  // Whisper identifies the format from the file name, so it must match the real type.
  const form = new FormData();
  form.append('file', blob, `audio.${EXTENSIONS[mime] || 'wav'}`);
  form.append('model', 'whisper-large-v3');
  form.append('language', 'ar');
  form.append('response_format', 'json');

  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new TranscriptionError('UPSTREAM_TIMEOUT', 'تأخرت خدمة تحويل الصوت. أعد المحاولة.', 504);
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    console.error('[Transcription] Groq error', { status: response.status, message: detail?.error?.message });
    if (response.status === 401 || response.status === 403) throw new TranscriptionError('UPSTREAM_AUTH', 'مفتاح خدمة تحويل الصوت غير صالح.');
    if (response.status === 429) throw new TranscriptionError('UPSTREAM_RATE_LIMIT', 'تم تجاوز حد الاستخدام مؤقتاً. أعد المحاولة بعد قليل.');
    throw new TranscriptionError('UPSTREAM_ERROR', 'تعذر تحويل الصوت إلى نص.');
  }
  const result = await response.json().catch(() => ({}));
  return typeof result.text === 'string' ? result.text.trim() : '';
}
