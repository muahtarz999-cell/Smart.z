export const runtime = 'edge';

import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    // ط§ط³طھظ‚ط¨ظ„ ط§ظ„طµظˆطھ ظ…ظ† ط§ظ„ط¹ظ…ظٹظ„
    const formData = await req.formData();
    const audioBlob = formData.get('audio');

    if (!audioBlob) {
      return NextResponse.json(
        { error: true, message: 'No audio data provided.' },
        { status: 400 }
      );
    }

    // طھط­ظ‚ظ‚ ظ…ظ† ظˆط¬ظˆط¯ Groq API Key
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      console.error('[Transcribe] Missing GROQ_API_KEY');
      return NextResponse.json(
        { error: true, message: 'API key missing or authentication failed.' },
        { status: 500 }
      );
    }

    // ط­ظˆظ„ ط§ظ„ظ€ blob ط¥ظ„ظ‰ Buffer

    // ط£ظ†ط´ط¦ FormData ظ„ظ„ط±ظپط¹ ط¥ظ„ظ‰ Groq
    const groqFormData = new FormData();
    groqFormData.append('file', audioBlob, 'audio.wav');
    groqFormData.append('model', 'whisper-large-v3');
    groqFormData.append('language', 'ar');

    // ط£ط±ط³ظ„ ط§ظ„ط·ظ„ط¨ ط¥ظ„ظ‰ Groq
    const groqResponse = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
        },
        body: groqFormData,
      }
    );

    // طھط¹ط§ظ…ظ„ ظ…ط¹ ط§ظ„ط£ط®ط·ط§ط،
    if (!groqResponse.ok) {
      const errorData = await groqResponse.json().catch(() => ({}));
      console.error(`[Transcribe] Groq error ${groqResponse.status}:`, errorData);

      if (groqResponse.status === 401 || groqResponse.status === 403) {
        return NextResponse.json(
          { error: true, message: 'API key missing or authentication failed.' },
          { status: 401 }
        );
      }

      if (groqResponse.status >= 500) {
        return NextResponse.json(
          { error: true, message: 'API key missing or authentication failed.' },
          { status: 500 }
        );
      }

      return NextResponse.json(
        {
          error: true,
          message: errorData.error?.message || 'Transcription failed.',
        },
        { status: groqResponse.status }
      );
    }

    const result = await groqResponse.json();
    const text = result.text || '';

    return NextResponse.json({ text });
  } catch (err) {
    console.error('[Transcribe] Unexpected error:', err);
    return NextResponse.json(
      { error: true, message: 'API key missing or authentication failed.' },
      { status: 500 }
    );
  }
}

