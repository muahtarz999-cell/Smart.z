import { NextResponse } from 'next/server';
import { AssistantResponseError, generateAssistantReply } from '../../../lib/assistant-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';

export const runtime = 'edge';

function errorResponse(message, status) {
  return NextResponse.json(
    { error: true, message },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON request.', 400);
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) return errorResponse('A non-empty message is required.', 400);

  try {
    const reply = await generateAssistantReply(message);
    return NextResponse.json(
      { reply },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const configurationError = error instanceof AssistantResponseError
      && error.code === 'CONFIGURATION';
    console.error('[Assistant API] Reply generation failed', {
      code: error instanceof AssistantResponseError ? error.code : 'UNEXPECTED',
    });
    return errorResponse(
      configurationError ? 'Assistant service is not configured.' : 'Assistant service is temporarily unavailable.',
      configurationError ? 503 : 502
    );
  }
}
