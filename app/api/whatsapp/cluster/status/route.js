import { json } from '../../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import { callNode, ClusterError, CLUSTER_MESSAGES, getClusterNode, getUserAssignment } from '../../../../../lib/whatsapp-cluster';


export async function GET(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  let assignment;
  try {
    assignment = await getUserAssignment(access.user.id, access.client);
  } catch (error) {
    const code = error instanceof ClusterError ? error.code : 'ASSIGNMENT_LOOKUP_FAILED';
    return json({ status: 'ERROR', error: CLUSTER_MESSAGES[code] }, 503);
  }
  if (!assignment) {
    return json({ status: 'DISCONNECTED', connected: false, assigned: false, autoReply: false });
  }

  const base = {
    assigned: true,
    nodeId: assignment.node_id,
    autoReply: assignment.auto_reply_enabled === true,
    replyScope: assignment.reply_scope || 'all',
    allowedNumbers: assignment.allowed_numbers || [],
    voiceReplyMode: assignment.voice_reply_mode || 'match',
  };
  const node = getClusterNode(assignment.node_id);
  if (!node) return json({ ...base, status: 'ERROR', connected: false, error: CLUSTER_MESSAGES.ASSIGNED_NODE_NOT_CONFIGURED }, 503);

  try {
    const result = await callNode(node, '/api/status', { timeoutMs: 8_000 });
    const data = result.data || {};
    const connected = data.status === 'CONNECTED';
    const dbStatus = connected ? 'connected' : 'pending';
    if (assignment.status !== dbStatus || (connected && data.phone && data.phone !== assignment.phone_number)) {
      await access.client.from('whatsapp_tenant_nodes')
        .update({ status: dbStatus, phone_number: data.phone || assignment.phone_number, last_status_check: new Date().toISOString() })
        .eq('user_id', access.user.id);
    }
    return json({ ...base, status: data.status || 'UNKNOWN', connected, phone: data.phone || null, hasQr: Boolean(data.hasQr) });
  } catch {
    return json({ ...base, status: 'WAKING', connected: false });
  }
}
