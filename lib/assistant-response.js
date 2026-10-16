import { PROFILE_LIMITS, profileToPrompt, sanitizeProfile } from './learned-profile.js';

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
  voice: 'الرد سيُقرأ بصوت عالٍ: لا تستخدم رموز Markdown أو القوائم أو الجداول أو الروابط. اكتب جملًا قصيرة، والأرقام والتواريخ بالكلمات، وتجنّب الكلمات الإنجليزية ما أمكن، وشكّل الكلمات التي قد يلتبس نطقها فقط.',
  driving: 'المستخدم يقود السيارة ويسمع الرد بصوت عالٍ: جملة أو جملتان قصيرتان فقط، بلا رموز أو قوائم أو روابط، والأرقام والأوقات بالكلمات. لا تطلب منه قراءة شيء أو النظر إلى الشاشة أو الكتابة. إذا احتاج الجواب تفاصيل كثيرة فقل الخلاصة واعرض إكمالها حين يتوقف.',
  whatsapp: 'أنت ترد نيابة عن صاحب الحساب على رسالة WhatsApp وصلته من شخص آخر. كن مختصرًا ومهذبًا، ولا تقطع وعودًا أو مواعيد باسمه.',
  whatsapp_voice: 'أنت ترد نيابة عن صاحب الحساب برسالة صوتية في WhatsApp على شخص آخر. جملتان قصيرتان على الأكثر، بلا رموز أو روابط، والأرقام بالكلمات، وشكّل الكلمات الملتبسة. لا تقطع وعودًا أو مواعيد باسمه.',
  text: '',
};
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARACTERS = 1500;
const MAX_LEARNING_MESSAGES = 12;

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

const MAX_DOCUMENT_CONTEXT = 12_000;

/** Passages of the user's file chosen on the device; sanitised and capped here again. */
export function documentContextToPrompt(context) {
  if (!context || !Array.isArray(context.passages) || !context.passages.length) return '';
  const name = String(context.name || 'ملف').replace(/[\u0000-\u001f]/g, ' ').slice(0, 120);
  let total = 0;
  const lines = [];
  for (const passage of context.passages) {
    const text = typeof passage?.text === 'string' ? passage.text.trim() : '';
    if (!text) continue;
    if (total + text.length > MAX_DOCUMENT_CONTEXT) break;
    total += text.length;
    const page = Number.isInteger(passage.page) ? `[ص${passage.page}] ` : '';
    lines.push(`${page}${text}`);
  }
  if (!lines.length) return '';
  const pages = Number.isInteger(context.pageCount) ? ` (${context.pageCount} صفحة)` : '';
  return [
    `مقتطفات من ملف المستخدم «${name}»${pages}، اختارها التطبيق لأنها الأقرب لسؤاله:`,
    ...lines,
    'أجب من هذه المقتطفات واذكر رقم الصفحة عند الاستشهاد. إذا لم تكفِ للإجابة فقل ذلك واقترح على المستخدم تحديد الصفحة. لا تخترع ما ليس فيها.',
  ].join('\n');
}

function buildMessages(message, options = {}) {
  const extra = [
    documentContextToPrompt(options.documentContext),
    profileToPrompt(options.profile, options.memories),
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

async function requestCompletion(endpoint, apiKey, model, messages, timeoutMs, extraBody = {}) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, ...extraBody }),
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

// ---------------------------------------------------------------- tools (voice commands)

export const WHATSAPP_SEND_TOOL = {
  type: 'function',
  function: {
    name: 'send_whatsapp_message',
    description: 'يرسل رسالة WhatsApp من رقم المستخدم. استخدمه فقط عندما يطلب المستخدم صراحة إرسال رسالة لشخص أو أشخاص أو مجموعة.',
    parameters: {
      type: 'object',
      properties: {
        recipients: {
          type: 'array',
          items: { type: 'string' },
          description: 'أسماء المستلمين أو أرقامهم كما قالها المستخدم بالضبط، مثل "أحمد" أو "أمي" أو "0501234567".',
        },
        message: {
          type: 'string',
          description: 'نص الرسالة النهائي كما سيرسله المستخدم بنفسه: بصيغة المتكلم وبلهجته، دون إضافات أو تحية لم يطلبها.',
        },
        to_group: {
          type: 'boolean',
          description: 'true فقط إذا قال المستخدم صراحة "مجموعة" أو "قروب" أو "جروب" مع اسمها.',
        },
        attach_document: {
          type: 'string',
          description: 'إذا طلب إرسال مستند كتبه في التطبيق (عقد، خطاب، سيرة): اسمه كما قاله مثل "عقد الإيجار"، أو "latest" لآخر مستند. اتركه فارغاً لرسالة نصية فقط.',
        },
      },
      required: ['recipients'],
    },
  },
};

const TOOLS_INSTRUCTION = 'لديك أداة send_whatsapp_message لإرسال رسائل WhatsApp من رقم المستخدم. إذا طلب إرسال رسالة فاستدعها مباشرة دون أن تطلب تأكيدًا، فالتطبيق يتولى التنفيذ. لا ترسل لمجموعة إلا إذا ذكرها المستخدم صراحة.';

async function requestChat(endpoint, apiKey, model, body, timeoutMs) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const result = await response.json().catch(() => null);
    return result?.choices?.[0]?.message || null;
  } catch {
    return null;
  }
}

function parseToolCalls(message) {
  return (Array.isArray(message?.tool_calls) ? message.tool_calls : [])
    .map((call) => {
      let args = {};
      try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { return null; }
      return call?.function?.name ? { name: call.function.name, args } : null;
    })
    .filter(Boolean);
}

/**
 * Like generateAssistantReply, but the model may call tools.
 * Returns { reply: string, toolCalls: [{ name, args }] }.
 */
export async function generateAssistantTurn(message, options = {}) {
  const tools = Array.isArray(options.tools) ? options.tools : [];
  if (!tools.length) return { reply: await generateAssistantReply(message, options), toolCalls: [] };

  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKeys = [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_BACKUP].filter(Boolean);
  if (!groqKey && openRouterKeys.length === 0) throw new AssistantResponseError('CONFIGURATION');

  const messages = buildMessages(message, options);
  messages[0] = { role: 'system', content: `${messages[0].content}\n\n${TOOLS_INSTRUCTION}` };
  const body = { messages, tools, tool_choice: 'auto' };
  const attempts = [
    ...(groqKey ? [[GROQ_ENDPOINT, groqKey, GROQ_MODEL, 10_000]] : []),
    ...openRouterKeys.map((key) => [OPENROUTER_ENDPOINT, key, OPENROUTER_MODEL, 7_000]),
  ];
  for (const [endpoint, key, model, timeout] of attempts) {
    const reply = await requestChat(endpoint, key, model, body, timeout);
    if (!reply) continue;
    const toolCalls = parseToolCalls(reply);
    const content = typeof reply.content === 'string' ? reply.content.trim() : '';
    if (toolCalls.length || content) return { reply: content, toolCalls };
  }
  throw new AssistantResponseError('UPSTREAM');
}

// ---------------------------------------------------------------- documents and study

/** One-shot completion with a custom system prompt (documents, study tools). Returns text. */
export async function completeWithSystem(system, user, { json = false, timeoutMs = 25_000 } = {}) {
  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKeys = [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_BACKUP].filter(Boolean);
  if (!groqKey && openRouterKeys.length === 0) throw new AssistantResponseError('CONFIGURATION');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const extra = json ? { response_format: { type: 'json_object' }, temperature: 0.3 } : { temperature: 0.4 };
  const attempts = [
    ...(groqKey ? [[GROQ_ENDPOINT, groqKey, GROQ_MODEL]] : []),
    ...openRouterKeys.map((key) => [OPENROUTER_ENDPOINT, key, OPENROUTER_MODEL]),
  ];
  for (const [endpoint, key, model] of attempts) {
    const text = await requestCompletion(endpoint, key, model, messages, timeoutMs, extra);
    if (text) return text;
  }
  throw new AssistantResponseError('UPSTREAM');
}

export function parseJsonReply(text) {
  return extractJson(String(text || ''));
}

// ---------------------------------------------------------------- learning

const LEARNING_INSTRUCTIONS = `أنت محرّك "تعلّم" لمساعد شخصي. مهمتك تحديث ملف قصير عن المستخدم من محادثته الأخيرة.
أعد JSON فقط بهذا الشكل بالضبط:
{"name":"","dialect":"","speakingStyle":"","preferences":[],"facts":[]}

القواعد:
- ابدأ من الملف الحالي، أضف الجديد، وصحّح أو احذف ما ناقضه المستخدم صراحة. لا تحذف معلومة صحيحة لم تُذكر.
- سجّل فقط ما قاله المستخدم عن نفسه أو ما يظهر بوضوح من كلامه. لا تخمّن ولا تستنتج ما لم يُقل.
- dialect: لهجته كما تظهر من كلامه (مثل: سعودية نجدية، حجازية، مصرية، شامية) أو اتركها فارغة.
- speakingStyle: جملة قصيرة عن طريقته (مختصر/مفصّل، رسمي/عفوي، يمزج الإنجليزية...).
- preferences: كيف يحب أن يُخاطَب ويُجاب (حتى ${PROFILE_LIMITS.preferences.count}).
- facts: حقائق مفيدة لخدمته: عمله، مدينته، اهتماماته، أسماء من يذكرهم كثيراً، مواعيد متكررة (حتى ${PROFILE_LIMITS.facts.count})، كل حقيقة جملة قصيرة مستقلة.
- لا تسجّل أبداً: كلمات مرور أو أرقام بطاقات أو حسابات أو هويات، تفاصيل صحية أو دينية أو سياسية أو جنسية، أو أسرار عن أشخاص آخرين.
- إن لم يظهر جديد فأعد الملف الحالي كما هو.
- اكتب بالعربية.`;

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Returns the updated, sanitised profile. Throws AssistantResponseError on failure. */
export async function learnProfile(currentProfile, transcript) {
  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKeys = [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_BACKUP].filter(Boolean);
  if (!groqKey && openRouterKeys.length === 0) throw new AssistantResponseError('CONFIGURATION');

  const conversation = (Array.isArray(transcript) ? transcript : [])
    .filter((turn) => (turn?.role === 'user' || turn?.role === 'assistant')
      && typeof turn.content === 'string' && turn.content.trim())
    .slice(-MAX_LEARNING_MESSAGES)
    .map((turn) => ({ role: turn.role, content: turn.content.trim().slice(0, MAX_HISTORY_CHARACTERS) }))
    .map((turn) => `${turn.role === 'user' ? 'المستخدم' : 'المساعد'}: ${turn.content}`)
    .join('\n');
  if (!conversation) return sanitizeProfile(currentProfile);

  const messages = [
    { role: 'system', content: LEARNING_INSTRUCTIONS },
    {
      role: 'user',
      content: `الملف الحالي:\n${JSON.stringify(sanitizeProfile(currentProfile))}\n\nالمحادثة الأخيرة:\n${conversation}`,
    },
  ];
  const jsonMode = { response_format: { type: 'json_object' }, temperature: 0.2 };

  const attempts = [
    ...(groqKey ? [[GROQ_ENDPOINT, groqKey, GROQ_MODEL]] : []),
    ...openRouterKeys.map((key) => [OPENROUTER_ENDPOINT, key, OPENROUTER_MODEL]),
  ];
  for (const [endpoint, key, model] of attempts) {
    const text = await requestCompletion(endpoint, key, model, messages, 15_000, jsonMode);
    const parsed = text ? extractJson(text) : null;
    if (parsed) return sanitizeProfile(parsed);
  }
  throw new AssistantResponseError('UPSTREAM');
}
