/**
 * Image understanding (server only), OpenAI-compatible chat with image parts.
 * Provider chain from VISION_PROVIDER_ORDER (default groq,gemini,openrouter);
 * model names are env-configurable because they change often — verify them
 * against each provider's docs when deploying.
 */

export const MAX_VISION_IMAGES = 3;
export const MAX_IMAGE_BASE64_LENGTH = 7_000_000; // ≈5 MB per image after base64

const PROVIDERS = {
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    key: () => process.env.GROQ_API_KEY,
    model: () => process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b',
  },
  gemini: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    key: () => process.env.GEMINI_API_KEY,
    model: () => process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash',
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    key: () => process.env.OPENROUTER_API_KEY,
    model: () => process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash',
  },
};

export class VisionError extends Error {
  constructor(code, failures = []) {
    super(code);
    this.code = code;
    this.failures = failures;
  }
}

export function visionProviderOrder() {
  return (process.env.VISION_PROVIDER_ORDER || 'groq,gemini,openrouter')
    .split(',').map((name) => name.trim()).filter((name) => PROVIDERS[name]?.key());
}

const VISION_SYSTEM = 'أنت مساعد يقرأ الصور والمستندات المصوّرة بدقة. أجب بالعربية ما لم يكتب المستخدم بغيرها. انقل النصوص والأرقام كما هي دون تخمين، وإذا كان جزء غير واضح فقل ذلك. لا تذكر تفاصيل تقنية.';

/** images: base64 JPEG strings. Returns { reply, provider }. */
export async function analyzeImages({ question, images, systemExtra = '', history = [] }) {
  const order = visionProviderOrder();
  if (!order.length) throw new VisionError('NO_PROVIDERS');
  const content = [
    { type: 'text', text: question },
    ...images.map((data) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } })),
  ];
  const messages = [
    { role: 'system', content: systemExtra ? `${VISION_SYSTEM}\n\n${systemExtra}` : VISION_SYSTEM },
    ...history,
    { role: 'user', content },
  ];
  const failures = [];
  for (const name of order) {
    const provider = PROVIDERS[name];
    try {
      const response = await fetch(provider.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.key()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: provider.model(), messages, temperature: 0.2 }),
        signal: AbortSignal.timeout(30_000),
        cache: 'no-store',
      });
      if (!response.ok) { failures.push(`${name}:${response.status}`); continue; }
      const data = await response.json().catch(() => null);
      const reply = data?.choices?.[0]?.message?.content;
      if (typeof reply === 'string' && reply.trim()) return { reply: reply.trim(), provider: name };
      failures.push(`${name}:EMPTY`);
    } catch (error) {
      failures.push(`${name}:${error?.name || 'ERROR'}`);
    }
  }
  throw new VisionError('ALL_FAILED', failures);
}
