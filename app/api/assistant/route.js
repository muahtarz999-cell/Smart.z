import { json } from '../../../lib/api-response';
import { AssistantResponseError, generateAssistantTurn, WHATSAPP_SEND_TOOL } from '../../../lib/assistant-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';
import { getClusterNode, getUserAssignment } from '../../../lib/whatsapp-cluster';
import { nodeContactSearch, planSendCommand } from '../../../lib/whatsapp-commands';

export const runtime = 'edge';

const MAX_MESSAGE_CHARACTERS = 4000;

/** The personal WhatsApp node of this customer, when linked (enables voice commands). */
async function linkedWhatsAppNode(access) {
  try {
    const assignment = await getUserAssignment(access.user.id, access.client);
    return assignment?.status === 'connected' ? getClusterNode(assignment.node_id) : null;
  } catch {
    return null;
  }
}

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: true, message: 'Invalid JSON request.' }, 400);

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE_CHARACTERS) : '';
  if (!message) return json({ error: true, message: 'A non-empty message is required.' }, 400);

  const node = await linkedWhatsAppNode(access);
  try {
    const turn = await generateAssistantTurn(message, {
      history: body.history, // sanitised inside: last 6 turns, user/assistant only
      responseStyle: body.responseStyle,
      language: body.language,
      channel: body.channel === 'voice' ? 'voice' : 'text',
      // Present only when the user consented to learning; sanitised and size-limited inside.
      profile: body.profile,
      memories: body.memories,
      tools: node ? [WHATSAPP_SEND_TOOL] : [],
    });

    const send = turn.toolCalls.find((call) => call.name === 'send_whatsapp_message');
    if (send && node) {
      const plan = await planSendCommand(send.args, nodeContactSearch(node));
      return json({ reply: plan.reply, action: plan.action || null });
    }
    if (!turn.reply) throw new AssistantResponseError('UPSTREAM');
    return json({ reply: turn.reply });
  } catch (error) {
    const code = error instanceof AssistantResponseError ? error.code : 'UNEXPECTED';
    console.error('[Assistant API] Reply generation failed', { code });
    return code === 'CONFIGURATION'
      ? json({ error: true, message: 'Assistant service is not configured.' }, 503)
      : json({ error: true, message: 'Assistant service is temporarily unavailable.' }, 502);
  }
}
