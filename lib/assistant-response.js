const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'openai/gpt-oss-120b';
const SYSTEM_MESSAGE = `أنت المساعد الشخصي الذكي Smart.z: مساعد حاضر، ودود، وحيوي بطبيعية ومن دون تكلّف. افهم العربية ولهجاتها جيدًا، وأجب بلغة المستخدم، وبالعربية عندما يكتب بالعربية.

اجعل الحوار خفيفًا وسهل الاستماع: ابدأ بالإجابة مباشرة، واستخدم جملًا قصيرة مترابطة وكلمات مألوفة. في الأسئلة اليومية، فضّل جوابًا موجزًا من جملتين أو ثلاث؛ وإذا كان الموضوع يحتاج شرحًا، قدّم الخلاصة أولًا ثم اعرض التوسّع. تجنّب المقدمات المحفوظة، وتكرار عبارات مثل «بالطبع» و«يسعدني مساعدتك»، والحشو، والقوائم الطويلة ما لم تطلبها الحاجة. نوّع بدايات الردود وإيقاع صياغتها، وأظهر الحماس باعتدال عندما يناسب الموقف. كن هادئًا ومتعاطفًا في المواضيع الحساسة، ومهنيًا من دون جمود.

حافظ على الدقة: لا تخترع معلومات غير معروفة، ووضّح ما لا تعرفه عند الحاجة. لا تذكر تفاصيل تقنية داخلية إلا إذا كانت ضرورية، ولا تدّع تنفيذ أي إجراء لم تنفذه فعليًا.`;

const STYLE_INSTRUCTIONS = {
  short: 'اجعل الرد قصيرًا جدًا: جملة أو جملتان.',
  medium: '',
  detailed: 'قدّم ردًا مفصلًا عندما يحتاج السؤال ذلك، مع الخلاصة أولًا.',
};
const CHANNEL_INSTRUCTIONS = {
  voice: 'الرد سيُقرأ بصوت عالٍ: لا تستخدم رموز Markdown أو القوائم أو الجداول أو الروابط.',
  whatsapp: 'أنت ترد نيابة عن صاحب الحساب على رسالة WhatsApp وصلته من شخص آخر. كن مختصرًا ومهذبًا، ولا تقطع وعودًا أو مواعيد باسمه.',
  text: '',
};
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARACTERS = 1500;

export class AssistantResponseError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Keeps only well-formed, recent turns; anything else from the client is dropped. */
export function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((turn) => (turn?.role === 'user' || turn?.role === 'assistant')
      && typeof turn.content === 'string' && turn.content.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map((turn) => ({ role: turn.role, content: turn.content.trim().slice(0, MAX_HISTORY_CHARACTERS) }));
}

function buildMessages(message, options = {}) {
  const extra = [
    STYLE_INSTRUCTIONS[options.responseStyle] || '',
    CHANNEL_INSTRUCTIONS[options.channel] || '',
    options.language === 'en' ? 'Reply in English unless the user writes in Arabic.' : '',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: extra ? `${SYSTEM_MESSAGE}\n\n${extra}` : SYSTEM_MESSAGE },
    ...sanitizeHistory(options.history),
    { role: 'user', content: message },
  ];
}

async function requestCompletion(endpoint, apiKey, model, messages, timeoutMs) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const result = await response.json().catch(() => null);
  const reply = result?.choices?.[0]?.message?.content;
  return typeof reply === 'string' && reply.trim() ? reply.trim() : null;
}

/**
 * Groq first, then each OpenRouter key. Total worst case ~24 s, under the
 * 30 s budget of the WhatsApp nodes.
 */
export async function generateAssistantReply(message, options = {}) {
  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKeys = [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_BACKUP].filter(Boolean);
  if (!groqKey && openRouterKeys.length === 0) throw new AssistantResponseError('CONFIGURATION');

  const messages = buildMessages(message, options);
  if (groqKey) {
    const reply = await requestCompletion(GROQ_ENDPOINT, groqKey, GROQ_MODEL, messages, 10_000);
    if (reply) return reply;
  }
  for (const key of openRouterKeys) {
    const reply = await requestCompletion(OPENROUTER_ENDPOINT, key, OPENROUTER_MODEL, messages, 7_000);
    if (reply) return reply;
  }
  throw new AssistantResponseError('UPSTREAM');
}
