import { json } from '../../../../lib/api-response';
import { AssistantResponseError, decideWithTool } from '../../../../lib/assistant-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../lib/customer-access';
import {
  buildStepPrompt,
  MAX_AGENT_STEPS,
  PHONE_AGENT_SYSTEM,
  sanitizeHistory,
  sanitizeScreen,
  UI_ACTION_TOOL,
  validateStepAction,
} from '../../../../lib/phone-agent-step';

export const runtime = 'nodejs';

const MAX_BODY_CHARACTERS = 60_000;

/** One step of the Android phone agent: current screen in, one action out. */
export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const raw = await request.text().catch(() => '');
  if (!raw || raw.length > MAX_BODY_CHARACTERS) return json({ error: true, message: 'Invalid request.' }, 400);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: true, message: 'Invalid JSON request.' }, 400); }

  const goal = typeof body?.goal === 'string' ? body.goal.trim().slice(0, 500) : '';
  const step = Number.isInteger(body?.step) && body.step >= 0 ? body.step : 0;
  if (!goal) return json({ error: true, message: 'A goal is required.' }, 400);
  if (step >= MAX_AGENT_STEPS) {
    return json({ action: { action: 'need_user', say: 'وصلت للحد الأقصى من الخطوات. أكمل بنفسك أو أعد الطلب بخطوات أوضح.' } });
  }

  const screen = sanitizeScreen(body.screen);
  const prompt = buildStepPrompt({
    goal,
    appName: typeof body.appName === 'string' ? body.appName.trim().slice(0, 80) : '',
    screen,
    history: sanitizeHistory(body.history),
    step,
  });

  try {
    const args = await decideWithTool(PHONE_AGENT_SYSTEM, prompt, UI_ACTION_TOOL);
    return json({ action: validateStepAction(args, screen) });
  } catch (error) {
    const code = error instanceof AssistantResponseError ? error.code : 'UNEXPECTED';
    console.error('[Phone agent] step failed', { code });
    return json({ error: true, message: 'Assistant service is temporarily unavailable.' }, code === 'CONFIGURATION' ? 503 : 502);
  }
}
