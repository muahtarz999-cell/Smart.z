import { json } from '../../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import { allocateNode, callNode, ClusterError, CLUSTER_MESSAGES } from '../../../../../lib/whatsapp-cluster';

export const runtime = 'edge';

export async function GET(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const { searchParams } = new URL(request.url);
  const method = searchParams.get('method') === 'pairing_code' ? 'pairing_code' : 'qr';
  const phoneNumber = (searchParams.get('phoneNumber') || '').replace(/\D/g, '');
  if (method === 'pairing_code' && (phoneNumber.length < 9 || phoneNumber.length > 15)) {
    return json({ success: false, error: 'اكتب رقم الهاتف مع رمز الدولة، مثل 9665xxxxxxxx.' }, 400);
  }

  let node;
  try {
    ({ node } = await allocateNode(access.client, access.user.id));
  } catch (error) {
    const code = error instanceof ClusterError ? error.code : 'CLAIM_FAILED';
    console.error('[WhatsApp personal] allocation failed', { code });
    return json({ success: false, code, error: CLUSTER_MESSAGES[code] || CLUSTER_MESSAGES.CLAIM_FAILED },
      error instanceof ClusterError ? error.status : 500);
  }

  try {
    const result = await callNode(node, '/api/connect', {
      query: { method, phoneNumber: method === 'pairing_code' ? phoneNumber : undefined },
      timeoutMs: 25_000,
    });
    const data = result.data && typeof result.data === 'object' ? result.data : {};

    if (data.connected) {
      await access.client.from('whatsapp_tenant_nodes')
        .update({ status: 'connected', phone_number: data.phone || null, last_status_check: new Date().toISOString() })
        .eq('user_id', access.user.id);
    }

    return json({
      success: Boolean(data.success),
      pending: Boolean(data.pending),
      type: data.type || null,
      qr: data.qr || null,
      pairingCode: data.pairingCode || null,
      status: data.status || 'UNKNOWN',
      connected: Boolean(data.connected),
      phone: data.phone || null,
      error: data.success ? undefined : (data.error || 'تعذر تجهيز الربط على الخادم.'),
      nodeId: node.id,
    }, result.status);
  } catch {
    // Render free instances sleep; the first request wakes them and takes up to a minute.
    return json({ success: true, pending: true, status: 'WAKING', nodeId: node.id }, 202);
  }
}
