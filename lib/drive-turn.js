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
import { parseCallCommand, whatsAppJidFor } from './call-rules.js';

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

  const callCommand = context.ringingCall?.number ? parseCallCommand(transcript, { driving: true }) : null;
  if (callCommand) {
    // The phone is ringing and the driver said «رد» / «ارفض» / «ارفض وقل له…».
    ({ reply, action } = planCallControl(callCommand, context.ringingCall, Boolean(deps.planSend)));
    kind = 'call_control';
    actionDelivery = 'service';
  } else if (isDrivingStopCommand(transcript)) {
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
  const voiced = await voiceReply(reply, context.voice, deps.synthesize);
  return { kind, transcript, reply, action, actionDelivery, audio: voiced.audio, voiceProvider: voiced.provider };

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

/**
 * A call command while the phone rings → what the service does and says.
 * A message goes by WhatsApp (needs it linked); without it the call is only rejected.
 */
export function planCallControl(command, ringingCall = {}, whatsappLinked = false) {
  const name = String(ringingCall.name || '').slice(0, 80);
  if (command.decision === 'answer') {
    return { reply: 'أرد الآن.', action: { type: 'call_control', decision: 'answer' } };
  }
  const jid = whatsAppJidFor(ringingCall.number, ringingCall.countryIso);
  if (command.decision === 'reject_message' && whatsappLinked && jid) {
    return {
      reply: `رفضت المكالمة وأرسلت له في واتساب: ${command.message}`,
      action: { type: 'call_control', decision: 'reject_message', message: command.message, jid, name },
    };
  }
  return {
    reply: command.decision === 'reject_message' ? 'رفضت المكالمة. إرسال الرسالة يحتاج ربط واتساب.' : 'رفضت المكالمة.',
    action: { type: 'call_control', decision: 'reject' },
  };
}

/** At most this many voice requests at once: firing every chunk together hit the providers' rate limits. */
export const SPEECH_CONCURRENCY = 2;

/**
 * Voices a reply in ONE voice, so driving mode sounds like the main screen.
 *
 *   1. The first chunk is voiced with the user's chosen voice (then the
 *      provider chain if that one is down); whoever answers sets the voice.
 *   2. Every other chunk is pinned to that same provider and voice (two at
 *      a time, one retry each). No chunk silently switches to another voice.
 *   3. If a chunk still fails, audio is empty and `provider` tells the phone
 *      which voice to keep: it voices the reply sentence by sentence in that
 *      voice, then any cloud voice, then its own (DrivingModeService).
 *
 * Returns { audio: [{ mime, data }], provider }. Empty audio, never a reply with holes.
 */
export async function voiceReply(reply, voice = {}, synthesize) {
  const chunks = splitForSpeech(textForSpeech(reply), 180);
  if (!chunks.length || !synthesize) return { audio: [], provider: null };
  const attempt = (text, options) => Promise.resolve().then(() => synthesize(text, options)).catch(() => null);

  const first = (await attempt(chunks[0], voice)) || (await attempt(chunks[0], voice));
  if (!first?.audio) return { audio: [], provider: null };
  const provider = first.provider || null;
  const pinned = provider ? { ...voice, provider, strict: true } : voice;

  const results = new Array(chunks.length);
  results[0] = first;
  let next = 1;
  const worker = async () => {
    while (next < chunks.length) {
      const index = next;
      next += 1;
      results[index] = (await attempt(chunks[index], pinned)) || (await attempt(chunks[index], pinned));
    }
  };
  await Promise.all(Array.from({ length: Math.min(SPEECH_CONCURRENCY, chunks.length - 1) }, worker));
  if (results.some((result) => !result?.audio)) return { audio: [], provider };
  return { audio: results.map((result) => ({ mime: result.contentType, data: bytesToBase64(result.audio) })), provider };
}

/** The audio part of voiceReply (kept for callers that only need the chunks). */
export async function speakChunks(reply, voice = {}, synthesize) {
  return (await voiceReply(reply, voice, synthesize)).audio;
}
