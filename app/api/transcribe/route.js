import { json } from '../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';
import { transcribeAudio, TranscriptionError } from '../../../lib/transcription';

export const runtime = 'edge';

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  let audio;
  try {
    audio = (await request.formData()).get('audio');
  } catch {
    return json({ error: true, code: 'BAD_REQUEST', message: 'لم يصل ملف الصوت.' }, 400);
  }
  if (!audio || typeof audio === 'string') return json({ error: true, code: 'NO_AUDIO', message: 'لم يصل ملف الصوت.' }, 400);

  try {
    return json({ text: await transcribeAudio(audio, audio.type) });
  } catch (error) {
    if (error instanceof TranscriptionError) {
      // Upstream problems are 502, never 401, so the app does not mistake them for an expired login.
      return json({ error: true, code: error.code, message: error.message }, error.status);
    }
    console.error('[Transcribe] unexpected', error);
    return json({ error: true, code: 'UNEXPECTED', message: 'تعذر تحويل الصوت إلى نص.' }, 500);
  }
}
