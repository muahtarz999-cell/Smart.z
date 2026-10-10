import { NextResponse } from 'next/server';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';

export const runtime = 'edge';

const GROQ_SPEECH_ENDPOINT = 'https://api.groq.com/openai/v1/audio/speech';
const GROQ_SPEECH_MODEL = 'canopylabs/orpheus-arabic-saudi';
const DEFAULT_VOICE = 'noura';
const MAX_INPUT_CHARACTERS = 200;
const APP_ORIGIN = 'https://smart-z.pages.dev';

function responseHeaders(request, headers = {}) {
  const result = new Headers({
    ...headers,
    'Cache-Control': 'no-store',
  });
  if (request.headers.get('origin') === APP_ORIGIN) {
    result.set('Access-Control-Allow-Origin', APP_ORIGIN);
    result.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    result.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    result.set('Vary', 'Origin');
  }
  return result;
}

function errorResponse(request, message, status) {
  return NextResponse.json(
    { error: true, message },
    { status, headers: responseHeaders(request) }
  );
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: responseHeaders(request) });
}

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, 'Invalid JSON request.', 400);
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return errorResponse(request, 'Speech text is required.', 400);
  if ([...text].length > MAX_INPUT_CHARACTERS) {
    return errorResponse(request, `Speech text must not exceed ${MAX_INPUT_CHARACTERS} characters.`, 400);
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('[Speech API] Missing GROQ_API_KEY');
    return errorResponse(request, 'Speech service is not configured.', 503);
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
    return errorResponse(request, 'Speech service is temporarily unavailable.', 502);
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
      request,
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
    return errorResponse(request, 'Speech generation returned an invalid audio file.', 502);
  }

  return new Response(groqResponse.body, {
    status: 200,
    headers: responseHeaders(request, {
      'Content-Type': 'audio/wav',
      'X-Content-Type-Options': 'nosniff',
    }),
  });
}
