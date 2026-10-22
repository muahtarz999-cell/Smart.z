import { json } from '../../../../../lib/api-response';
import {
  buildAcceptBody,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  isVipCaller,
  parseSipHeaders,
  routingCandidates,
  verifyWebhookSignature,
} from '../../../../../lib/receptionist';
import { findReceptionistOwner, loadReceptionistSettings } from '../../../../../lib/receptionist-store';
import { callNode, createServiceClient, getConfiguredClusterNodes, getUserAssignment, nodeForAssignment } from '../../../../../lib/whatsapp-cluster';

export const runtime = 'nodejs';

const OPENAI_CALLS = 'https://api.openai.com/v1/realtime/calls';

async function openai(callId, action, body) {
  const response = await fetch(`${OPENAI_CALLS}/${encodeURIComponent(callId)}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  return response.ok;
}

/** The Render node that follows the call: the customer's WhatsApp node, else the first one configured. */
async function monitorNode(service, userId) {
  try {
    const assignment = await getUserAssignment(userId, service);
    const own = nodeForAssignment(assignment);
    if (own) return own;
  } catch {
    // fall through to any node
  }
  return getConfiguredClusterNodes()[0] || null;
}

/**
 * OpenAI calls this for every SIP call to the project (realtime.call.incoming).
 * The called number picks the customer; unknown numbers and switched-off
 * receptionists are declined. Nothing about the call is stored here.
 */
export async function POST(request) {
  const secret = process.env.OPENAI_WEBHOOK_SECRET;
  if (!secret || !process.env.OPENAI_API_KEY) return json({ error: 'NOT_CONFIGURED' }, 503);

  const body = await request.text();
  const valid = await verifyWebhookSignature({
    id: request.headers.get('webhook-id'),
    timestamp: request.headers.get('webhook-timestamp'),
    signature: request.headers.get('webhook-signature'),
    body,
    secret,
  }).catch(() => false);
  if (!valid) return json({ error: 'INVALID_SIGNATURE' }, 401);

  let event;
  try { event = JSON.parse(body); } catch { return json({ error: 'INVALID_JSON' }, 400); }
  if (event?.type !== 'realtime.call.incoming') return json({ status: 'ignored' });

  const callId = typeof event.data?.call_id === 'string' ? event.data.call_id : '';
  if (!callId) return json({ error: 'NO_CALL_ID' }, 400);

  const service = createServiceClient();
  if (!service) return json({ error: 'DATABASE_CONFIGURATION' }, 503);

  const sip = parseSipHeaders(event.data?.sip_headers);
  let owner;
  try {
    owner = await findReceptionistOwner(service, routingCandidates(sip));
  } catch {
    owner = null;
  }
  if (!owner) {
    console.warn('[Receptionist] call to an unassigned number declined');
    await openai(callId, 'reject', { status_code: 404 }).catch(() => false);
    return json({ status: 'rejected', reason: 'UNKNOWN_NUMBER' });
  }

  const [{ data: customer }, settings] = await Promise.all([
    service.from('customer_registry').select('is_active').eq('user_id', owner.userId).maybeSingle(),
    loadReceptionistSettings(service, owner.userId).catch(() => null),
  ]);
  const switchedOn = owner.channel === 'whatsapp' ? settings?.whatsappEnabled : settings?.enabled;
  if (!customer || customer.is_active === false || !settings || !switchedOn) {
    await openai(callId, 'reject', { status_code: 486 }).catch(() => false);
    return json({ status: 'rejected', reason: 'OFF' });
  }

  const callerNumber = sip.from || '';
  const context = { channel: owner.channel, callerNumber, vip: isVipCaller(settings, callerNumber) };
  const accepted = await openai(callId, 'accept', buildAcceptBody(settings, context, {
    model: process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
    voice: process.env.OPENAI_REALTIME_VOICE || DEFAULT_REALTIME_VOICE,
  })).catch(() => false);
  if (!accepted) {
    console.error('[Receptionist] accept failed');
    return json({ status: 'accept_failed' }, 502);
  }

  // A Render node follows the call (greeting, tools, transcript) and reports it for the summary.
  const node = await monitorNode(service, owner.userId);
  if (node) {
    await callNode(node, '/api/calls/monitor', {
      method: 'POST',
      timeoutMs: 6_000,
      body: {
        callId,
        userId: owner.userId,
        channel: owner.channel,
        callerNumber,
        transferNumber: owner.channel === 'phone' ? settings.transferNumber : '',
      },
    }).catch(() => console.warn('[Receptionist] monitor node unreachable; the call continues without a summary'));
  }
  return json({ status: 'accepted' });
}
