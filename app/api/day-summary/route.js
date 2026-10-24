import { json } from '../../../lib/api-response';
import { generateAssistantReply } from '../../../lib/assistant-response';
import { resolveUserLocation, sanitizeCoords, validTimeZone } from '../../../lib/assistant-context';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';
import { summaryContextToPrompt } from '../../../lib/day-summary';

/** «لخّص يومي»: what the phone gathered (only on this request) → one spoken-friendly summary. Nothing is kept. */
export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: true, message: 'Invalid JSON request.' }, 400);
  const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 300) : 'لخّص يومي';
  const timeZone = validTimeZone(body.timeZone) ? body.timeZone : undefined;
  const location = await resolveUserLocation(request, sanitizeCoords(body.coords)).catch(() => null);

  try {
    const reply = await generateAssistantReply(message, {
      extraInstruction: summaryContextToPrompt(body.context),
      channel: ['voice', 'driving'].includes(body.channel) ? body.channel : 'text',
      responseStyle: body.responseStyle,
      language: body.language,
      timeZone,
      location,
    });
    return json({ reply });
  } catch {
    return json({ error: true, message: 'تعذّر إعداد الملخص الآن. حاول بعد قليل.' }, 502);
  }
}
