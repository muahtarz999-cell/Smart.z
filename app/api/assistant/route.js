import { json } from '../../../lib/api-response';
import { AssistantResponseError, generateAssistantTurn, WHATSAPP_SEND_TOOL } from '../../../lib/assistant-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';
import { linkedWhatsAppNode, nodeContactSearch, planSendCommand } from '../../../lib/whatsapp-commands';
import { DRIVING_MESSAGES } from '../../../lib/driving-commands';


const MAX_MESSAGE_CHARACTERS = 4000;

/** What the assistant says about a planned send, given where it will wait. */
function sendReplyFor(plan, body) {
  const action = plan.action;
  if (!action) return plan.reply;
  const driving = body.channel === 'driving';
  if (action.requiresManualConfirmation) return driving ? DRIVING_MESSAGES.bulkHeld : plan.reply;
  if (body.confirmEverySend === true) return driving ? DRIVING_MESSAGES.heldForConfirmation : 'الرسالة جاهزة، أكّدها من الشاشة.';
  return plan.reply;
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
      channel: ['voice', 'driving'].includes(body.channel) ? body.channel : 'text',
      // Present only when the user consented to learning; sanitised and size-limited inside.
      profile: body.profile,
      memories: body.memories,
      documentContext: body.documentContext, // passages from a local file, chosen on the device
      legalContext: body.legalContext, // selected articles from the on-device legal library
      inboxContext: body.inboxContext, // WhatsApp messages stored on the phone, only when asked about them
      tools: node ? [WHATSAPP_SEND_TOOL] : [],
      whatsappLinked: Boolean(node),
    });

    const send = turn.toolCalls.find((call) => call.name === 'send_whatsapp_message');
    if (send && node) {
      const plan = await planSendCommand(send.args, nodeContactSearch(node));
      return json({ reply: sendReplyFor(plan, body), action: plan.action || null });
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
