import { json } from '../../../../../lib/api-response';
import { generateAssistantReply } from '../../../../../lib/assistant-response';
import { synthesizeWithFallback } from '../../../../../lib/cloud-tts';
import { splitForSpeech } from '../../../../../lib/text-chunks';
import { transcribeAudio } from '../../../../../lib/transcription';
import { createServiceClient, getClusterNode } from '../../../../../lib/whatsapp-cluster';
import { isReplyAllowed, wantsVoiceReply } from '../../../../../lib/whatsapp-reply-rules';

export const runtime = 'edge';

const MAX_VOICE_CHUNKS = 4;

function sameToken(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Called by a Render node for every incoming 1:1 text or voice note.
 * Body: { nodeId, remoteJid, senderNumber?, text? , audio?: { data: base64, mimetype }, messageId }
 * Reply: { success, reply, transcript?, voice?: [{ data, contentType }] } or { success, reply: null, skipped }
 */
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const node = getClusterNode(body?.nodeId);
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!node || !token || !sameToken(token, node.key)) {
    return json({ success: false, error: 'UNAUTHORIZED_CLUSTER_NODE' }, 401);
  }

  const database = createServiceClient();
  if (!database) return json({ success: false, error: 'DATABASE_CONFIGURATION' }, 503);

  const { data: tenant, error } = await database
    .from('whatsapp_tenant_nodes')
    .select('*')
    .eq('node_id', node.id)
    .maybeSingle();
  if (error) return json({ success: false, error: 'TENANT_LOOKUP_FAILED' }, 503);
  if (!isReplyAllowed(tenant, body.senderNumber || body.remoteJid)) {
    return json({ success: true, reply: null, skipped: tenant?.auto_reply_enabled ? 'NOT_IN_ALLOWLIST' : 'AUTO_REPLY_OFF' });
  }

  const { data: customer } = await database.from('customer_registry').select('*').eq('user_id', tenant.user_id).maybeSingle();
  if (!customer || customer.is_active === false) return json({ success: true, reply: null, skipped: 'CUSTOMER_INACTIVE' });

  // 1. Text, or the transcript of a voice note.
  const incomingIsVoice = Boolean(body.audio?.data);
  let text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
  let transcript;
  if (incomingIsVoice) {
    try {
      transcript = await transcribeAudio(base64ToBytes(body.audio.data), body.audio.mimetype || 'audio/ogg');
    } catch (transcriptionError) {
      console.error('[WhatsApp personal] voice note transcription failed', { code: transcriptionError?.code });
      return json({ success: false, error: 'TRANSCRIPTION_FAILED' }, 502);
    }
    text = transcript;
  }
  if (!text) return json({ success: true, reply: null, skipped: 'EMPTY_MESSAGE' });

  // 2. The reply, written for the form it will be delivered in.
  const asVoice = wantsVoiceReply(tenant, incomingIsVoice);
  let reply;
  try {
    reply = await generateAssistantReply(text, { channel: asVoice ? 'whatsapp_voice' : 'whatsapp' });
  } catch (replyError) {
    console.error('[WhatsApp personal] reply failed', { code: replyError?.code || 'UNEXPECTED' });
    return json({ success: false, error: 'ASSISTANT_UNAVAILABLE' }, 502);
  }

  // 3. Voice reply: synthesise each chunk, sticking to the provider that answered first.
  let voice;
  if (asVoice) {
    try {
      voice = [];
      let provider;
      for (const chunk of splitForSpeech(reply).slice(0, MAX_VOICE_CHUNKS)) {
        const result = await synthesizeWithFallback(chunk, { provider });
        provider = result.provider;
        voice.push({ data: bytesToBase64(result.audio), contentType: result.contentType });
      }
    } catch (speechError) {
      console.warn('[WhatsApp personal] voice reply failed, sending text', { code: speechError?.code });
      voice = undefined; // the node sends the text instead
    }
  }

  return json({ success: true, reply, transcript, voice, messageId: body.messageId || null });
}
