import { json } from '../../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../lib/customer-access';
import { callNode } from '../../../../lib/whatsapp-cluster';
import { linkedWhatsAppNode } from '../../../../lib/whatsapp-commands';
import { sanitizeInboxItems } from '../../../../lib/whatsapp-inbox';


/**
 * Passes incoming messages from the customer's WhatsApp node to the phone.
 * Nothing is stored here: the phone saves them locally, then confirms with
 * POST so the node forgets them.
 */
export async function GET(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const node = await linkedWhatsAppNode(access);
  if (!node) return json({ success: true, linked: false, items: [] });
  try {
    const result = await callNode(node, '/api/inbox', { timeoutMs: 20_000 });
    const items = sanitizeInboxItems(result.data?.items);
    return json({ success: Boolean(result.ok), linked: true, waking: result.data?.connected === false, items });
  } catch {
    // A sleeping free node takes up to a minute to wake; the next sync collects.
    return json({ success: false, linked: true, waking: true, items: [] }, 202);
  }
}

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string' && id.length <= 128).slice(0, 500) : [];
  if (!ids.length) return json({ success: true, removed: 0 });

  const node = await linkedWhatsAppNode(access);
  if (!node) return json({ success: true, removed: 0 });
  try {
    const result = await callNode(node, '/api/inbox/ack', { method: 'POST', body: { ids }, timeoutMs: 15_000 });
    return json({ success: Boolean(result.ok), removed: Number(result.data?.removed) || 0 });
  } catch {
    return json({ success: false, removed: 0 }, 202);
  }
}
