import { NextResponse } from 'next/server';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';

export const runtime = 'edge';

const GROQ_SPEECH_ENDPOINT = 'https://api.groq.com/openai/v1/audio/speech';
const GROQ_SPEECH_MODEL = 'canopylabs/orpheus-arabic-saudi';
const DEFAULT_VOICE = 'noura';
const MAX_INPUT_CHARACTERS = 200;

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

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return errorResponse('Speech text is required.', 400);
  if ([...text].length > MAX_INPUT_CHARACTERS) {
    return errorResponse(`Speech text must not exceed ${MAX_INPUT_CHARACTERS} characters.`, 400);
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('[Speech API] Missing GROQ_API_KEY');
    return errorResponse('Speech service is not configured.', 503);
  }

  let groqResponse;
  try {
    groqResponse = await fetch(GROQ_SPEECH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_SPEECH_MODEL,
        input: text,
        voice: DEFAULT_VOICE,
        response_format: 'wav',
      }),
      cache: 'no-store',
    });
  } catch (error) {
    console.error('[Speech API] Groq request failed:', error);
    return errorResponse('Speech service is temporarily unavailable.', 502);
  }

  if (!groqResponse.ok) {
    const providerError = await groqResponse.json().catch(() => null);
    const providerMessage = typeof providerError?.error?.message === 'string'
      ? providerError.error.message.slice(0, 300)
      : '';
    console.error('[Speech API] Groq returned an error:', {
      status: groqResponse.status,
      code: providerError?.error?.code,
      message: providerMessage,
    });
    return errorResponse(
      groqResponse.status === 429
        ? 'Speech service is busy. Please try again shortly.'
        : providerMessage
          ? `Groq ${groqResponse.status}: ${providerMessage}`
          : `Speech generation failed (Groq ${groqResponse.status}).`,
      groqResponse.status === 429 ? 429 : 502
    );
  }

  if (!groqResponse.headers.get('content-type')?.includes('audio')) {
    console.error('[Speech API] Groq returned a non-audio response.');
    return errorResponse('Speech generation returned an invalid audio file.', 502);
  }

  return new Response(groqResponse.body, {
    status: 200,
    headers: {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
