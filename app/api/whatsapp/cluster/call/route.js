import { json } from '../../../../../lib/api-response';
import { decideWhatsAppCall } from '../../../../../lib/call-rules';
import { createServiceClient, getClusterNode, slotFromBody } from '../../../../../lib/whatsapp-cluster';

function sameToken(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

/**
 * Asked by a Render node for every incoming WhatsApp call.
 * Body: { nodeId }. Reply: { success, reject, message } — the node rejects the
 * call and sends the message when reject is true. Nothing about the caller is stored.
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
    .eq('slot', slotFromBody(body))
    .maybeSingle();
  if (error) return json({ success: false, error: 'TENANT_LOOKUP_FAILED' }, 503);
  if (!tenant) return json({ success: true, reject: false, message: null });

  const { data: customer } = await database.from('customer_registry').select('is_active').eq('user_id', tenant.user_id).maybeSingle();
  if (!customer || customer.is_active === false) return json({ success: true, reject: false, message: null });

  return json({ success: true, ...decideWhatsAppCall(tenant) });
}
