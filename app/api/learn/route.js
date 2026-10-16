import { json } from '../../../lib/api-response';
import { AssistantResponseError, learnProfile } from '../../../lib/assistant-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';

export const runtime = 'edge';

/**
 * Stateless: the device sends its current profile and recent turns, gets the
 * updated profile back, and stores it itself. Nothing is saved or logged here.
 * The device only calls this after the user has consented to learning.
 */
export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) return json({ error: true, message: 'messages must be an array.' }, 400);

  try {
    const profile = await learnProfile(body.profile, body.messages);
    return json({ profile });
  } catch (error) {
    const code = error instanceof AssistantResponseError ? error.code : 'UNEXPECTED';
    console.error('[Learn API] failed', { code });
    return json({ error: true, code, message: 'تعذر تحديث ملف التعلّم الآن.' }, code === 'CONFIGURATION' ? 503 : 502);
  }
}
