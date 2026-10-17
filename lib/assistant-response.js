import { groqKeysInOrder, isKeySpecificFailure, reportGroqFailure } from './groq-keys.js';
import { PROFILE_LIMITS, profileToPrompt, sanitizeProfile } from './learned-profile.js';
import { inboxContextToPrompt } from './whatsapp-inbox.js';
import { withProviderPrivacy } from './provider-privacy.js';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'openai/gpt-oss-120b';
const SYSTEM_MESSAGE = `أنت المساعد الشخصي الذكي Smart.z: مساعد حاضر، ودود، وحيوي بطبيعية ومن دون تكلّف. افهم العربية ولهجاتها جيدًا، وأجب بلغة المستخدم، وبالعربية عندما يكتب بالعربية.

اجعل الحوار خفيفًا وسهل الاستماع: ابدأ بالإجابة مباشرة، واستخدم جملًا قصيرة مترابطة وكلمات مألوفة. في الأسئلة اليومية، فضّل جوابًا موجزًا من جملتين أو ثلاث؛ وإذا كان الموضوع يحتاج شرحًا، قدّم الخلاصة أولًا ثم اعرض التوسّع. تجنّب المقدمات المحفوظة، وتكرار عبارات مثل «بالطبع» و«يسعدني مساعدتك»، والحشو، والقوائم الطويلة ما لم تطلبها الحاجة. نوّع بدايات الردود وإيقاع صياغتها، وأظهر الحماس باعتدال عندما يناسب الموقف. كن هادئًا ومتعاطفًا في المواضيع الحساسة، ومهنيًا من دون جمود.

حافظ على الدقة: لا تخترع معلومات غير معروفة، ووضّح ما لا تعرفه عند الحاجة. لا تذكر تفاصيل تقنية داخلية إلا إذا كانت ضرورية، ولا تدّع تنفيذ أي إجراء لم تنفذه فعليًا.

إذا سُئلت من صنعك أو طوّرك أو برمجك فقل: صنعني م. زياد.`;

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
    options.inboxContext ? inboxContextToPrompt(options.inboxContext) : '',
    profileToPrompt(options.profile, options.memories),
    STYLE_INSTRUCTIONS[options.responseStyle] || '',
    CHANNEL_INSTRUCTIONS[options.channel] || '',
    options.language === 'en' ? 'Reply in English unless the user writes in Arabic.' : '',
    typeof options.extraInstruction === 'string' ? options.extraInstruction : '',
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
      body: JSON.stringify(withProviderPrivacy(endpoint, { model, messages, ...extraBody })),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
  } catch {
    return { value: null, status: 0 };
  }
  if (!response.ok) return { value: null, status: response.status };
  const result = await response.json().catch(() => null);
  const reply = result?.choices?.[0]?.message?.content;
  return { value: typeof reply === 'string' && reply.trim() ? reply.trim() : null, status: response.status };
}

/**
 * Every Groq key (rotating, healthy first), then each OpenRouter key.
 * Throws CONFIGURATION when nothing is set.
 */
function providerAttempts(groqTimeoutMs, openRouterTimeoutMs) {
  const groq = groqKeysInOrder().map((key) => ({ groq: true, endpoint: GROQ_ENDPOINT, key, model: GROQ_MODEL, timeoutMs: groqTimeoutMs }));
  const openRouter = [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_BACKUP].filter(Boolean)
    .map((key) => ({ groq: false, endpoint: OPENROUTER_ENDPOINT, key, model: OPENROUTER_MODEL, timeoutMs: openRouterTimeoutMs }));
  if (!groq.length && !openRouter.length) throw new AssistantResponseError('CONFIGURATION');
  return [...groq, ...openRouter];
}

/**
 * Runs the attempts in order until `run` yields a value. Another Groq key is
 * tried only when the failure belonged to the key (rate limit, revoked); a
 * timeout or server error means Groq itself is struggling, so the remaining
 * Groq keys are skipped and OpenRouter answers instead.
 */
async function firstSuccessful(attempts, run) {
  let skipGroq = false;
  for (const attempt of attempts) {
    if (attempt.groq && skipGroq) continue;
    const { value, status } = await run(attempt);
    if (value !== null && value !== undefined) return value;
    if (attempt.groq) {
      reportGroqFailure(attempt.key, status);
      if (!isKeySpecificFailure(status)) skipGroq = true;
    }
  }
  return null;
}

/**
 * Groq keys first, then each OpenRouter key. A Groq timeout skips the other
 * Groq keys, so the worst case stays ~24 s, under the 30 s budget of the
 * WhatsApp nodes; rate-limited keys fail fast and cost almost nothing.
 */
export async function generateAssistantReply(message, options = {}) {
  const attempts = providerAttempts(10_000, 7_000);
  const messages = buildMessages(message, options);
  const reply = await firstSuccessful(attempts, (attempt) => requestCompletion(
    attempt.endpoint, attempt.key, attempt.model, messages, attempt.timeoutMs));
  if (reply) return reply;
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
        as_voice: {
          type: 'boolean',
          description: 'true فقط إذا طلب المستخدم صراحة أن تكون رسالة صوتية (صوتية، فويس، ريكورد، بصوت). يُقرأ نص message بصوت المساعد ويُرسل كرسالة صوتية.',
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

const TOOLS_INSTRUCTION = [
  'رقم WhatsApp الخاص بالمستخدم مربوط بالتطبيق الآن، ولديك أداة send_whatsapp_message لإرسال رسائل منه إلى جهات اتصاله ومجموعاته.',
  'إذا طلب إرسال رسالة فاستدعها مباشرة دون أن تطلب تأكيدًا، فالتطبيق يتولى التنفيذ. لا ترسل لمجموعة إلا إذا ذكرها المستخدم صراحة.',
  'تستطيع إرسال الرسالة صوتية بصوت المساعد: إذا طلب رسالة صوتية فاجعل as_voice=true واكتب في message النص الذي سيُنطق بلهجته.',
  'إذا سألك هل لديك وصول إلى WhatsApp أو هل تستطيع الإرسال فأجب: نعم، أستطيع إرسال رسائل من رقمك، واطلب منه أن يذكر المستلم والنص.',
  'عندما يسأل عن رسائله الواردة يُرفق التطبيق الرسائل المحفوظة على هاتفه في هذه التعليمات؛ أجب منها ولا تقل إنك لا تستطيع الوصول. لا تصلك المحادثات التي سبقت ربط رقمه.',
].join(' ');

/** Said when the user's WhatsApp is not linked, so the assistant points to the right place instead of a vague refusal. */
const WHATSAPP_UNLINKED_INSTRUCTION = 'رقم WhatsApp غير مربوط بالتطبيق حاليًا. إذا طلب المستخدم إرسال رسالة WhatsApp فأخبره بإيجاز أن يربط رقمه من القائمة ← ربط التطبيقات ← WhatsApp ثم يعيد الطلب.';

async function requestChat(endpoint, apiKey, model, body, timeoutMs) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(withProviderPrivacy(endpoint, { model, ...body })),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!response.ok) return { value: null, status: response.status };
    const result = await response.json().catch(() => null);
    const message = result?.choices?.[0]?.message || null;
    const toolCalls = parseToolCalls(message);
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    return { value: toolCalls.length || content ? { reply: content, toolCalls } : null, status: response.status };
  } catch {
    return { value: null, status: 0 };
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
  if (!tools.length) {
    const hint = options.whatsappLinked === false ? WHATSAPP_UNLINKED_INSTRUCTION : '';
    return { reply: await generateAssistantReply(message, { ...options, extraInstruction: hint }), toolCalls: [] };
  }

  const attempts = providerAttempts(10_000, 7_000);
  const messages = buildMessages(message, options);
  messages[0] = { role: 'system', content: `${messages[0].content}\n\n${TOOLS_INSTRUCTION}` };
  const body = { messages, tools, tool_choice: 'auto' };
  const turn = await firstSuccessful(attempts, (attempt) => requestChat(
    attempt.endpoint, attempt.key, attempt.model, body, attempt.timeoutMs));
  if (turn) return turn;
  throw new AssistantResponseError('UPSTREAM');
}

// ---------------------------------------------------------------- documents and study

/** One-shot completion with a custom system prompt (documents, study tools). Returns text. */
export async function completeWithSystem(system, user, { json = false, timeoutMs = 25_000 } = {}) {
  const attempts = providerAttempts(timeoutMs, timeoutMs);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const extra = json ? { response_format: { type: 'json_object' }, temperature: 0.3 } : { temperature: 0.4 };
  const text = await firstSuccessful(attempts, (attempt) => requestCompletion(
    attempt.endpoint, attempt.key, attempt.model, messages, attempt.timeoutMs, extra));
  if (text) return text;
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
  const attempts = providerAttempts(15_000, 15_000);

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

  const parsed = await firstSuccessful(attempts, async (attempt) => {
    const { value, status } = await requestCompletion(
      attempt.endpoint, attempt.key, attempt.model, messages, attempt.timeoutMs, jsonMode);
    return { value: value ? extractJson(value) : null, status };
  });
  if (parsed) return sanitizeProfile(parsed);
  throw new AssistantResponseError('UPSTREAM');
}
