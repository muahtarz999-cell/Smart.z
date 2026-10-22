import { json } from '../../../../lib/api-response';
import { completeWithSystem, parseJsonReply } from '../../../../lib/assistant-response';
import { fallbackSummary, sanitizeCallReport, SUMMARY_SYSTEM, summaryPrompt } from '../../../../lib/receptionist';
import { saveCallLog } from '../../../../lib/receptionist-store';
import { callNode, createServiceClient, getClusterNode, getUserAssignment } from '../../../../lib/whatsapp-cluster';

export const runtime = 'nodejs';

function sameToken(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

/** Urgent call: a WhatsApp message to the owner's own number through their personal node, when linked. */
async function alertOwner(service, userId, text) {
  try {
    const assignment = await getUserAssignment(userId, service);
    const node = assignment?.status === 'connected' ? getClusterNode(assignment.node_id) : null;
    const own = String(assignment?.phone_number || '').replace(/\D/g, '');
    if (!node || !own) return;
    await callNode(node, '/api/send', { method: 'POST', timeoutMs: 10_000, body: { remoteJid: `${own}@s.whatsapp.net`, text } });
  } catch {
    // The call is still in the log.
  }
}

/**
 * A Render node reports a finished call: { nodeId, userId, callId, channel, callerNumber,
 * startedAt, endedAt, transcript: [{ role, text }], messages: [...], transferred }.
 * Stored: the summary and the recorded message only, never the transcript.
 */
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const node = getClusterNode(body?.nodeId);
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!node || !token || !sameToken(token, node.key)) return json({ success: false, error: 'UNAUTHORIZED_CLUSTER_NODE' }, 401);
  if (!/^[0-9a-f-]{36}$/i.test(String(body?.userId || ''))) return json({ success: false, error: 'INVALID_USER' }, 400);

  const report = sanitizeCallReport(body);
  if (!report.callId) return json({ success: false, error: 'INVALID_CALL' }, 400);
  const service = createServiceClient();
  if (!service) return json({ success: false, error: 'DATABASE_CONFIGURATION' }, 503);

  let summary = fallbackSummary(report);
  if (report.transcript.length || report.messages.length) {
    try {
      const parsed = parseJsonReply(await completeWithSystem(SUMMARY_SYSTEM, summaryPrompt(report), { json: true, timeoutMs: 20_000 }));
      if (parsed?.summary) {
        summary = {
          summary: String(parsed.summary).slice(0, 600),
          callerName: String(parsed.caller_name || summary.callerName || '').slice(0, 80),
          urgent: parsed.urgent === true || summary.urgent,
        };
      }
    } catch {
      // Keep the fallback summary.
    }
  }

  const message = report.messages[0];
  try {
    await saveCallLog(service, {
      user_id: body.userId,
      call_id: report.callId,
      channel: report.channel,
      caller_number: report.callerNumber || null,
      caller_name: summary.callerName || null,
      summary: summary.summary,
      message: message?.message || null,
      callback_number: message?.callbackNumber || null,
      urgent: summary.urgent,
      transferred: report.transferred,
      started_at: report.startedAt,
      ended_at: report.endedAt,
    });
  } catch {
    return json({ success: false, error: 'SAVE_FAILED' }, 503);
  }

  if (summary.urgent && !report.transferred) {
    const who = summary.callerName || report.callerNumber || 'متصل';
    await alertOwner(service, body.userId, `🔴 مكالمة عاجلة (${report.channel === 'whatsapp' ? 'واتساب' : 'هاتف'}) من ${who}${report.callerNumber ? ` — ${report.callerNumber}` : ''}:\n${summary.summary}`);
  }
  return json({ success: true });
}
