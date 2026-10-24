import { json } from '../../../../lib/api-response';
import { completeWithSystem, parseJsonReply } from '../../../../lib/assistant-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../lib/customer-access';
import { commitmentsFromModel, EXTRACTION_SYSTEM, MAX_EXTRACTION_LINES } from '../../../../lib/commitments';

/**
 * Hidden promises memory: the phone sends short WhatsApp lines that sound like
 * a promise, the model picks the real ones, and the notes go back to the phone.
 * Nothing is stored or logged here.
 */
export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  const lines = (Array.isArray(body?.lines) ? body.lines : [])
    .filter((line) => typeof line === 'string' && line.trim())
    .slice(-MAX_EXTRACTION_LINES)
    .map((line) => line.replace(/\s+/g, ' ').slice(0, 400));
  if (!lines.length) return json({ items: [] });

  const now = Date.now();
  try {
    const text = await completeWithSystem(EXTRACTION_SYSTEM,
      `الوقت الآن: ${new Date(now).toISOString()}\n\n${lines.join('\n')}`, { json: true, timeoutMs: 20_000 });
    return json({ items: commitmentsFromModel(parseJsonReply(text), now) });
  } catch {
    return json({ error: true, message: 'تعذّر التحليل الآن.' }, 502);
  }
}
