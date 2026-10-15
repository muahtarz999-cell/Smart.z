import { json } from '../../../lib/api-response';
import { AssistantResponseError, generateAssistantReply } from '../../../lib/assistant-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';

export const runtime = 'edge';

const MAX_MESSAGE_CHARACTERS = 4000;

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: true, message: 'Invalid JSON request.' }, 400);

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE_CHARACTERS) : '';
  if (!message) return json({ error: true, message: 'A non-empty message is required.' }, 400);

  try {
    const reply = await generateAssistantReply(message, {
      history: body.history, // sanitised inside: last 6 turns, user/assistant only
      responseStyle: body.responseStyle,
      language: body.language,
      channel: body.channel === 'voice' ? 'voice' : 'text',
    });
    return json({ reply });
  } catch (error) {
    const code = error instanceof AssistantResponseError ? error.code : 'UNEXPECTED';
    console.error('[Assistant API] Reply generation failed', { code });
    return code === 'CONFIGURATION'
      ? json({ error: true, message: 'Assistant service is not configured.' }, 503)
      : json({ error: true, message: 'Assistant service is temporarily unavailable.' }, 502);
  }
}
