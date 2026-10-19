import { json } from '../../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import { ClusterError, CLUSTER_MESSAGES, releaseNode } from '../../../../../lib/whatsapp-cluster';


export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  try {
    const result = await releaseNode(access.client);
    return json({ success: true, ...result });
  } catch (error) {
    const code = error instanceof ClusterError ? error.code : 'RELEASE_FAILED';
    console.error('[WhatsApp personal] release failed', { code });
    // NODE_RESET_FAILED: the row is already gone; a stale session is wiped again on the next claim.
    return json({ success: false, code, error: CLUSTER_MESSAGES[code] || CLUSTER_MESSAGES.RELEASE_FAILED }, 502);
  }
}
