import { NextResponse } from 'next/server';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';

export const runtime = 'edge';

const GROQ_SPEECH_ENDPOINT = 'https://api.groq.com/openai/v1/audio/speech';
const GROQ_SPEECH_MODEL = 'canopylabs/orpheus-arabic-saudi';
const SUPPORTED_VOICES = new Set([
  'abdullah',
  'fahad',
  'sultan',
  'lulwa',
  'noura',
  'aisha',
]);
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
  const voice = typeof body?.voice === 'string' ? body.voice : '';
  if (!text) return errorResponse('Speech text is required.', 400);
  if ([...text].length > MAX_INPUT_CHARACTERS) {
    return errorResponse(`Speech text must not exceed ${MAX_INPUT_CHARACTERS} characters.`, 400);
  }
  if (!SUPPORTED_VOICES.has(voice)) return errorResponse('Unsupported Arabic voice.', 400);

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
        voice,
        response_format: 'wav',
      }),
      cache: 'no-store',
    });
  } catch (error) {
    console.error('[Speech API] Groq request failed:', error);
    return errorResponse('Speech service is temporarily unavailable.', 502);
  }

  if (!groqResponse.ok) {
    console.error('[Speech API] Groq returned an error:', groqResponse.status);
    return errorResponse(
      groqResponse.status === 429
        ? 'Speech service is busy. Please try again shortly.'
        : 'Speech generation failed.',
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
