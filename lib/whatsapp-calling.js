// WhatsApp Business calling (Meta Cloud API) for the AI receptionist (owner request 2026-10-22).
// Calls to the business number go by SIP to the provider / SIP bridge set in
// WHATSAPP_CALLS_SIP_HOST, which passes them to OpenAI like the forwarded phone calls.
import { normalizeNumber } from './whatsapp-reply-rules.js';

export function graphVersion() {
  const version = String(process.env.META_GRAPH_API_VERSION || 'v23.0').trim();
  return /^v\d+\.\d+$/.test(version) ? version : 'v23.0';
}

export function sipServerConfig(env = process.env) {
  const hostname = String(env.WHATSAPP_CALLS_SIP_HOST || '').trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname)) return null;
  const port = String(env.WHATSAPP_CALLS_SIP_PORT || '5061').trim();
  return { hostname, port: /^\d{2,5}$/.test(port) ? port : '5061' };
}

/** Body of POST /{phone-number-id}/settings. */
export function callingSettingsBody(enabled, server) {
  if (!enabled) return { calling: { status: 'DISABLED' } };
  return {
    calling: {
      status: 'ENABLED',
      call_icon_visibility: 'DEFAULT',
      sip: { status: 'ENABLED', servers: [{ hostname: server.hostname, port: server.port }] },
    },
  };
}

/** The customer's active Meta business connection with its token, or null. */
export async function businessConnection(service, userId) {
  const { data: connection, error } = await service.from('whatsapp_connections')
    .select('id, phone_number_id, display_phone_number, status')
    .eq('user_id', userId).eq('status', 'connected')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error || !connection?.phone_number_id) return null;
  const { data: secret } = await service.from('whatsapp_connection_secrets')
    .select('access_token').eq('connection_id', connection.id).maybeSingle();
  if (!secret?.access_token) return null;
  return {
    phoneNumberId: String(connection.phone_number_id),
    number: normalizeNumber(connection.display_phone_number),
    accessToken: secret.access_token,
  };
}

export async function setMetaCalling(connection, enabled, server) {
  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(connection.phoneNumberId)}/settings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(callingSettingsBody(enabled, server)),
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok && data?.success !== false, message: data?.error?.message || null };
}
