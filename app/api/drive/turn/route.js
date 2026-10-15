import { json } from '../../../../lib/api-response';
import { AssistantResponseError, generateAssistantTurn, WHATSAPP_SEND_TOOL } from '../../../../lib/assistant-response';
import { synthesizeWithFallback } from '../../../../lib/cloud-tts';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../lib/customer-access';
import { runDriveTurn } from '../../../../lib/drive-turn';
import { transcribeAudio, TranscriptionError } from '../../../../lib/transcription';
import { linkedWhatsAppNode, nodeContactSearch, planSendCommand } from '../../../../lib/whatsapp-commands';

export const runtime = 'edge';

const MAX_CONTEXT_CHARACTERS = 24_000;

/**
 * Driving mode (Android service): multipart form with
 *   audio    the driver's sentence (16 kHz WAV)
 *   context  JSON { history, profile, memories, preferences, voice, pendingSend, confirmEverySend }
 * Returns { kind: reply|stop|cancel_send|ignored|error, transcript, reply, action, actionDelivery, audio: [{ mime, data }] }.
 * Nothing is stored; the context comes from the phone and goes back with the answer.
 */
export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  let audio;
  let context = {};
  try {
    const form = await request.formData();
    audio = form.get('audio');
    const raw = form.get('context');
    if (typeof raw === 'string' && raw.length <= MAX_CONTEXT_CHARACTERS) context = JSON.parse(raw) || {};
  } catch {
    return json({ error: true, code: 'BAD_REQUEST', message: 'طلب غير صالح.' }, 400);
  }
  if (!audio || typeof audio === 'string') return json({ error: true, code: 'NO_AUDIO', message: 'لم يصل الصوت.' }, 400);

  const node = await linkedWhatsAppNode(access);
  try {
    const result = await runDriveTurn({ audio, context }, {
      transcribe: (blob) => transcribeAudio(blob, blob.type || 'audio/wav'),
      assistantTurn: generateAssistantTurn,
      sendTool: WHATSAPP_SEND_TOOL,
      planSend: node ? (args) => planSendCommand(args, nodeContactSearch(node)) : null,
      synthesize: (text, voice) => synthesizeWithFallback(text, {
        provider: typeof voice?.provider === 'string' && voice.provider !== 'auto' ? voice.provider : undefined,
        voices: voice?.voices && typeof voice.voices === 'object' ? voice.voices : {},
      }),
    });
    return json(result);
  } catch (error) {
    if (error instanceof TranscriptionError) {
      return json({ error: true, code: error.code, message: error.message }, error.status);
    }
    const code = error instanceof AssistantResponseError ? error.code : 'UNEXPECTED';
    console.error('[Drive turn] failed', { code });
    return json({ error: true, code, message: 'المساعد غير متاح الآن. أعد المحاولة بعد قليل.' }, code === 'CONFIGURATION' ? 503 : 502);
  }
}
