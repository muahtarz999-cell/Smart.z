import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { AssistantResponseError, generateAssistantReply } from '../../../../lib/assistant-response';

export const runtime = 'edge';

const MAX_WEBHOOK_BYTES = 1_048_576;
const DEDUPLICATION_WINDOW_MS = 5 * 60 * 1000;
const MAX_DEDUPLICATED_MESSAGES = 1000;
const completedMessages = new Map();
const inFlightMessages = new Map();

class WebhookError extends Error {
  constructor(code, status = 500) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function response(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function equalTokens(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

async function readRawBody(request) {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    throw new WebhookError('PAYLOAD_TOO_LARGE', 413);
  }

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      throw new WebhookError('PAYLOAD_TOO_LARGE', 413);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function hasValidSignature(rawBody, header, appSecret) {
  const match = /^sha256=([a-f\d]{64})$/i.exec(header || '');
  if (!match) return false;

  const signature = new Uint8Array(32);
  for (let index = 0; index < signature.length; index += 1) {
    signature[index] = Number.parseInt(match[1].slice(index * 2, index * 2 + 2), 16);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify('HMAC', key, signature, rawBody);
}

function createWebhookSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new WebhookError('DATABASE_CONFIGURATION');

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function pruneCompletedMessages() {
  const oldestValidTime = Date.now() - DEDUPLICATION_WINDOW_MS;
  for (const [messageId, processedAt] of completedMessages) {
    if (processedAt < oldestValidTime) completedMessages.delete(messageId);
  }
  while (completedMessages.size >= MAX_DEDUPLICATED_MESSAGES) {
    const oldestMessageId = completedMessages.keys().next().value;
    if (!oldestMessageId) break;
    completedMessages.delete(oldestMessageId);
  }
}

async function processOnce(messageId, callback) {
  pruneCompletedMessages();
  if (completedMessages.has(messageId)) return;

  const existing = inFlightMessages.get(messageId);
  if (existing) return existing;

  const operation = (async () => {
    await callback();
    completedMessages.set(messageId, Date.now());
  })();
  inFlightMessages.set(messageId, operation);

  try {
    await operation;
  } finally {
    inFlightMessages.delete(messageId);
  }
}

async function getCustomerWhatsAppCredentials(database, phoneNumberId) {
  const { data: connection, error: connectionError } = await database
    .from('whatsapp_connections')
    .select('id,user_id')
    .eq('phone_number_id', phoneNumberId)
    .eq('status', 'connected')
    .maybeSingle();
  if (connectionError) throw new WebhookError('CONNECTION_LOOKUP_FAILED');
  if (!connection) return null;

  const { data: customer, error: customerError } = await database
    .from('customer_registry')
    .select('user_id')
    .eq('user_id', connection.user_id)
    .maybeSingle();
  if (customerError) throw new WebhookError('CUSTOMER_LOOKUP_FAILED');
  if (!customer) return null;

  const { data: secret, error: secretError } = await database
    .from('whatsapp_connection_secrets')
    .select('access_token,expires_at')
    .eq('connection_id', connection.id)
    .eq('user_id', connection.user_id)
    .maybeSingle();
  if (secretError) throw new WebhookError('TOKEN_LOOKUP_FAILED');
  if (!secret?.access_token) return null;

  if (secret.expires_at) {
    const expiresAt = Date.parse(secret.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  }

  return { accessToken: secret.access_token };
}

async function sendWhatsAppText(phoneNumberId, recipient, text, accessToken) {
  const apiVersion = getMetaGraphApiVersion();
  const graphResponse = await fetch(
    `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'text',
        text: { body: Array.from(text).slice(0, 4096).join('') },
      }),
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    }
  );
  if (!graphResponse.ok) throw new WebhookError('META_SEND_FAILED', 502);
}

function getMetaGraphApiVersion() {
  const apiVersion = process.env.META_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(apiVersion || '')) {
    throw new WebhookError('META_API_CONFIGURATION');
  }
  return apiVersion;
}

async function processMessage(database, value, message) {
  if (message.type !== 'text') return;

  const phoneNumberId = value?.metadata?.phone_number_id;
  const recipient = message.from;
  const text = message.text?.body;
  if (!/^\d+$/.test(phoneNumberId || '') || !/^\d{5,20}$/.test(recipient || '')) {
    throw new WebhookError('MESSAGE_METADATA_INVALID', 400);
  }
  if (typeof text !== 'string' || !text.trim()) return;

  const credentials = await getCustomerWhatsAppCredentials(database, phoneNumberId);
  if (!credentials) return;

  const reply = await generateAssistantReply(text.trim());
  await sendWhatsAppText(phoneNumberId, recipient, reply, credentials.accessToken);
}

export async function GET(request) {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) return response({ error: 'WEBHOOK_NOT_CONFIGURED' }, 503);

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode') || '';
  const token = searchParams.get('hub.verify_token') || '';
  const challenge = searchParams.get('hub.challenge');

  if (
    mode !== 'subscribe' ||
    !challenge ||
    challenge.length > 256 ||
    token.length > 512 ||
    !equalTokens(token, verifyToken)
  ) {
    return new Response('Forbidden', {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return new Response(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function POST(request) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return response({ error: 'WEBHOOK_NOT_CONFIGURED' }, 503);

  let rawBody;
  try {
    rawBody = await readRawBody(request);
  } catch (error) {
    return response(
      { error: 'INVALID_WEBHOOK_PAYLOAD' },
      error instanceof WebhookError ? error.status : 400
    );
  }

  let signatureIsValid;
  try {
    signatureIsValid = await hasValidSignature(
      rawBody,
      request.headers.get('x-hub-signature-256'),
      appSecret
    );
  } catch {
    return response({ error: 'SIGNATURE_VERIFICATION_FAILED' }, 400);
  }
  if (!signatureIsValid) return response({ error: 'INVALID_SIGNATURE' }, 401);

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return response({ error: 'INVALID_JSON' }, 400);
  }
  if (payload?.object !== 'whatsapp_business_account') {
    return response({ status: 'ignored' });
  }

  const textMessages = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const message of change.value?.messages || []) {
        if (message?.type === 'text' && typeof message.id === 'string' && message.id) {
          textMessages.push({ value: change.value, message });
        }
      }
    }
  }
  if (textMessages.length === 0) return response({ status: 'received' });

  let database;
  try {
    database = createWebhookSupabaseClient();
  } catch (error) {
    console.error('[WhatsApp webhook] Configuration failed', {
      code: error instanceof WebhookError ? error.code : 'DATABASE_CONFIGURATION',
    });
    return response({ error: 'WEBHOOK_NOT_CONFIGURED' }, 503);
  }

  try {
    for (const { value, message } of textMessages) {
      await processOnce(message.id, () => processMessage(database, value, message));
    }
    return response({ status: 'received' });
  } catch (error) {
    console.error('[WhatsApp webhook] Message processing failed', {
      code: error instanceof AssistantResponseError
        ? `ASSISTANT_${error.code}`
        : error instanceof WebhookError
          ? error.code
          : 'UNEXPECTED',
    });
    return response({ error: 'MESSAGE_PROCESSING_FAILED' }, 500);
  }
}
