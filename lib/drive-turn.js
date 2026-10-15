/**
 * One driving-mode turn for the Android service, in a single request:
 * the driver's sentence (audio) in, the spoken reply (audio) out.
 *
 *   audio → transcript → (noise | stop | cancel | reply via the assistant, with WhatsApp sends) → speech
 *
 * Dependencies are injected so the decision logic is testable without the
 * network. The route lives in app/api/drive/turn/route.js.
 */
import {
  DRIVING_MESSAGES, isCancelCommand, isDrivingStartCommand, isDrivingStopCommand, isLikelyHallucination,
} from './driving-commands.js';
import { splitForSpeech } from './text-chunks.js';

const MAX_SPOKEN_CHARACTERS = 700;

/** Markdown and links are never read aloud. */
export function textForSpeech(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>|~]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPOKEN_CHARACTERS);
}

export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Where a planned send goes:
 *   'service' — the Android service sends it after the undo window
 *   'app'     — it waits in the app for a tap (more than 5 people, "confirm every send", a document)
 */
export function sendDelivery(action, context = {}) {
  if (!action) return { delivery: null, reply: null };
  if (action.requiresManualConfirmation) return { delivery: 'app', reply: DRIVING_MESSAGES.bulkHeld };
  if (action.attachDocument) return { delivery: 'app', reply: DRIVING_MESSAGES.documentHeld };
  if (context.confirmEverySend === true) return { delivery: 'app', reply: DRIVING_MESSAGES.heldForConfirmation };
  return { delivery: 'service', reply: null };
}

/**
 * deps:
 *   transcribe(audio)                  → transcript
 *   assistantTurn(text, options)       → { reply, toolCalls }
 *   planSend(args) | null              → { reply, action? }   (null when WhatsApp is not linked)
 *   synthesize(text, voice)            → { audio: Uint8Array, contentType }
 *   sendTool                           tool definition passed to the assistant when planSend exists
 */
export async function runDriveTurn({ audio, context = {} }, deps) {
  const transcript = String(await deps.transcribe(audio) || '').trim();
  if (isLikelyHallucination(transcript)) return { kind: 'ignored', transcript };

  let kind = 'reply';
  let reply;
  let action = null;
  let actionDelivery = null;

  if (isDrivingStopCommand(transcript)) {
    kind = 'stop';
    reply = DRIVING_MESSAGES.stopped;
  } else if (context.pendingSend === true && isCancelCommand(transcript)) {
    kind = 'cancel_send';
    reply = DRIVING_MESSAGES.cancelled;
  } else if (isDrivingStartCommand(transcript)) {
    reply = 'وضع القيادة يعمل بالفعل.';
  } else {
    const preferences = context.preferences || {};
    const turn = await deps.assistantTurn(transcript, {
      history: context.history,
      profile: context.profile,
      memories: context.memories,
      responseStyle: preferences.responseStyle,
      language: preferences.language,
      channel: 'driving',
      tools: deps.planSend ? [deps.sendTool] : [],
    });
    const send = (turn.toolCalls || []).find((call) => call.name === 'send_whatsapp_message');
    if (send && deps.planSend) {
      const plan = await deps.planSend(send.args);
      action = plan.action || null;
      const routed = sendDelivery(action, context);
      actionDelivery = routed.delivery;
      reply = routed.reply || plan.reply;
    } else {
      reply = turn.reply;
    }
  }

  if (!reply) return { kind: 'error', transcript, message: 'لم يصل رد من المساعد.' };
  return { kind, transcript, reply, action, actionDelivery, audio: await speakChunks(reply, context.voice, deps.synthesize) };
}

/** Each chunk in parallel; an empty list means "use the phone's voice" (or text only, per settings). */
async function speakChunks(reply, voice = {}, synthesize) {
  const chunks = splitForSpeech(textForSpeech(reply), 180);
  if (!chunks.length || !synthesize) return [];
  try {
    const results = await Promise.all(chunks.map((chunk) => synthesize(chunk, voice)));
    return results.map((result) => ({ mime: result.contentType, data: bytesToBase64(result.audio) }));
  } catch {
    return [];
  }
}
