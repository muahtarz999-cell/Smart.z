import { json } from '../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';
import { listAvailableProviders, MAX_TTS_CHARACTERS, synthesizeWithFallback } from '../../../lib/cloud-tts';

export const runtime = 'edge';

// Which cloud voices are configured (for the settings screen).
export async function GET(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);
  return json({ providers: listAvailableProviders() });
}

// One chunk of reply text -> audio. Nothing is stored or logged.
export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return json({ error: true, message: 'text is required.' }, 400);
  if (text.length > MAX_TTS_CHARACTERS) return json({ error: true, message: 'text is too long.' }, 413);

  try {
    const result = await synthesizeWithFallback(text, {
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      voices: body.voices && typeof body.voices === 'object' ? body.voices : {},
      strict: body.strict === true, // keep this voice; the caller falls back itself
    });
    return new Response(result.audio, {
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'no-store',
        'X-TTS-Provider': result.provider,
        'X-TTS-Voice': result.voice,
      },
    });
  } catch (error) {
    console.error('[Speech API] cloud voice failed', { code: error?.code, failures: error?.failures });
    const code = error?.code === 'NO_PROVIDERS' ? 'NO_PROVIDERS' : 'CLOUD_TTS_FAILED';
    return json({
      error: true,
      code,
      message: code === 'NO_PROVIDERS' ? 'لا توجد خدمة صوت سحابية مضبوطة.' : 'تعذر توليد الصوت السحابي الآن.',
    }, code === 'NO_PROVIDERS' ? 503 : 502);
  }
}
