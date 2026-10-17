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
  DRIVING_MESSAGES, isCancelCommand, isDrivingStartCommand, isDrivingStopCommand, isLikelyHallucination, resolveCallByName,
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
 *   inboxContext(transcript) | absent  → stored WhatsApp messages when the driver asks about them
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
  } else {
    // Passengers talking: with "call by name" on, only sentences that call the
    // assistant (or answer it right after it spoke) go any further.
    const call = resolveCallByName(transcript, { required: context.callByName === true, followUp: context.followUp === true });
    if (!call.accept) return { kind: 'ignored', transcript, reason: 'not_called' };
    const request = call.text;
    if (call.onlyName) {
      reply = DRIVING_MESSAGES.called;
    } else if (isDrivingStartCommand(request)) {
      reply = 'وضع القيادة يعمل بالفعل.';
    } else {
      reply = await answer(request);
    }
  }

  if (!reply) return { kind: 'error', transcript, message: 'لم يصل رد من المساعد.' };
  return { kind, transcript, reply, action, actionDelivery, audio: await speakChunks(reply, context.voice, deps.synthesize) };

  async function answer(request) {
    const preferences = context.preferences || {};
    const inboxContext = deps.inboxContext ? await deps.inboxContext(request).catch(() => undefined) : undefined;
    const turn = await deps.assistantTurn(request, {
      history: context.history,
      profile: context.profile,
      memories: context.memories,
      responseStyle: preferences.responseStyle,
      language: preferences.language,
      channel: 'driving',
      tools: deps.planSend ? [deps.sendTool] : [],
      whatsappLinked: Boolean(deps.planSend),
      inboxContext,
    });
    const send = (turn.toolCalls || []).find((toolCall) => toolCall.name === 'send_whatsapp_message');
    if (send && deps.planSend) {
      const plan = await deps.planSend(send.args);
      action = plan.action || null;
      const routed = sendDelivery(action, context);
      actionDelivery = routed.delivery;
      return routed.reply || plan.reply;
    }
    return turn.reply;
  }
}

/** At most this many voice requests at once: firing every chunk together hit the providers' rate limits. */
export const SPEECH_CONCURRENCY = 2;

/**
 * Chunks are voiced two at a time; a chunk that failed (often a rate limit)
 * gets one more try on its own. An empty list means "the phone voices it"
 * (the service asks /api/speech per sentence, then the phone's own voice),
 * never a reply with holes.
 */
export async function speakChunks(reply, voice = {}, synthesize) {
  const chunks = splitForSpeech(textForSpeech(reply), 180);
  if (!chunks.length || !synthesize) return [];
  const results = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const index = next;
      next += 1;
      results[index] = await Promise.resolve()
        .then(() => synthesize(chunks[index], voice))
        .then((value) => ({ status: 'fulfilled', value }), () => ({ status: 'rejected' }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(SPEECH_CONCURRENCY, chunks.length) }, worker));
  const audio = [];
  for (let index = 0; index < chunks.length; index += 1) {
    let result = results[index].status === 'fulfilled' ? results[index].value : null;
    if (!result?.audio) result = await synthesize(chunks[index], voice).catch(() => null);
    if (!result?.audio) return [];
    audio.push({ mime: result.contentType, data: bytesToBase64(result.audio) });
  }
  return audio;
}
