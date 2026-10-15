import { json } from '../../../../../lib/api-response';
import { generateAssistantReply } from '../../../../../lib/assistant-response';
import { createServiceClient, getClusterNode } from '../../../../../lib/whatsapp-cluster';

export const runtime = 'edge';

function sameToken(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

// Called by a Render node for every incoming personal WhatsApp text.
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const node = getClusterNode(body?.nodeId);
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!node || !token || !sameToken(token, node.key)) {
    return json({ success: false, error: 'UNAUTHORIZED_CLUSTER_NODE' }, 401);
  }

  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
  if (!text) return json({ success: false, error: 'EMPTY_TEXT_MESSAGE' }, 400);

  const database = createServiceClient();
  if (!database) return json({ success: false, error: 'DATABASE_CONFIGURATION' }, 503);

  // Who owns this node, and do they want automatic replies?
  const { data: tenant, error } = await database
    .from('whatsapp_tenant_nodes')
    .select('user_id,auto_reply_enabled,status')
    .eq('node_id', node.id)
    .maybeSingle();
  if (error) return json({ success: false, error: 'TENANT_LOOKUP_FAILED' }, 503);
  if (!tenant || tenant.auto_reply_enabled !== true) return json({ success: true, reply: null, skipped: 'AUTO_REPLY_OFF' });

  const { data: customer } = await database
    .from('customer_registry')
    .select('*')
    .eq('user_id', tenant.user_id)
    .maybeSingle();
  if (!customer || customer.is_active === false) return json({ success: true, reply: null, skipped: 'CUSTOMER_INACTIVE' });

  try {
    const reply = await generateAssistantReply(text, { channel: 'whatsapp' });
    return json({ success: true, reply, messageId: body.messageId || null });
  } catch (replyError) {
    console.error('[WhatsApp personal] reply failed', { code: replyError?.code || 'UNEXPECTED' });
    return json({ success: false, error: 'ASSISTANT_UNAVAILABLE' }, 502);
  }
}
