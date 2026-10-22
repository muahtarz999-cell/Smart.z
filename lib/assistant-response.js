import { isKeySpecificFailure, reportGroqFailure } from './groq-keys.js';
import { brainAttempts } from './brain-providers.js';
import { PROFILE_LIMITS, profileToPrompt, sanitizeProfile } from './learned-profile.js';
import { inboxContextToPrompt } from './whatsapp-inbox.js';
import { withProviderPrivacy } from './provider-privacy.js';
import { normalizeArabic } from './arabic-normalize.js';
import { SELF_KNOWLEDGE } from './assistant-self-knowledge.js';
import { locationInstruction, timeInstruction } from './assistant-context.js';

const SYSTEM_MESSAGE = `أنت المساعد الشخصي الذكي Smart.z: مساعد حاضر، ودود، وحيوي بطبيعية ومن دون تكلّف. افهم العربية ولهجاتها جيدًا، وأجب بلغة المستخدم، وبالعربية عندما يكتب بالعربية.

اجعل الحوار خفيفًا وسهل الاستماع: ابدأ بالإجابة مباشرة، واستخدم جملًا قصيرة مترابطة وكلمات مألوفة. في الأسئلة اليومية، فضّل جوابًا موجزًا من جملتين أو ثلاث؛ وإذا كان الموضوع يحتاج شرحًا، قدّم الخلاصة أولًا ثم اعرض التوسّع. تجنّب المقدمات المحفوظة، وتكرار عبارات مثل «بالطبع» و«يسعدني مساعدتك»، والحشو، والقوائم الطويلة ما لم تطلبها الحاجة. نوّع بدايات الردود وإيقاع صياغتها، وأظهر الحماس باعتدال عندما يناسب الموقف. كن هادئًا ومتعاطفًا في المواضيع الحساسة، ومهنيًا من دون جمود.

حافظ على الدقة: لا تخترع معلومات غير معروفة، ووضّح ما لا تعرفه عند الحاجة. لا تذكر تفاصيل تقنية داخلية إلا إذا كانت ضرورية، ولا تدّع تنفيذ أي إجراء لم تنفذه فعليًا. التطبيق وحده يشغّل وضع القيادة ويوقفه: إذا طلب المستخدم تشغيله ووصل الطلب إليك فلا تقل إنه شُغّل، بل قل له بجملة واحدة: قل «شغّل وضع القيادة» أو اضغط زر وضع القيادة في القائمة.

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
const DOCUMENTS_INSTRUCTION = 'التطبيق يحفظ النصوص والعقود التي تكتبها في صفحة «مستنداتي» على جهاز المستخدم، ومنها يُنزَّل Word أو PDF. إذا طلب المستخدم نقل نص أو عقد إليها أو تنزيله ولم يُنفَّذ طلبه، فقل له بجملة واحدة أن يقول «احفظه في مستنداتي» أو «حمّله Word» وسيحفظه التطبيق بنصه كاملًا. ولا تقل إنك نقلته بنفسك.';
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

export function legalContextToPrompt(context) {
  if (!Array.isArray(context) || !context.length) return '';
  const clean = context.slice(0, 12).filter((item) => item?.law && item?.label && item?.text)
    .map((item) => `[${String(item.law).slice(0, 120)} — ${String(item.label).slice(0, 60)}${item.importedAt ? ` — استُورد ${String(item.importedAt).slice(0, 20)}` : ''}] ${String(item.text).slice(0, 3000)}`);
  return clean.length ? ['مواد من المكتبة القانونية على جهاز المستخدم:', ...clean, 'استند إلى هذه المواد وحدها، واذكر اسم النظام ورقم المادة. إن لم تكفِ فقل إن المكتبة لا تحتوي نصًا كافيًا، ولا تذكر أحكامًا من ذاكرتك.'].join('\n') : '';
}

function buildMessages(message, options = {}) {
  // Talking to the owner (not replying to someone else on WhatsApp): the assistant knows what it is and can do.
  const withOwner = !String(options.channel || '').startsWith('whatsapp');
  const extra = [
    withOwner ? SELF_KNOWLEDGE : '',
    withOwner && typeof options.statusInstruction === 'string' ? options.statusInstruction : '',
    // The model has no clock and no idea where the user is: always tell it (2026-10-22).
    withOwner ? timeInstruction(options.now || new Date(), options.timeZone) : '',
    withOwner && options.location !== undefined ? locationInstruction(options.location) : '',
    documentContextToPrompt(options.documentContext),
    legalContextToPrompt(options.legalContext),
    options.inboxContext ? inboxContextToPrompt(options.inboxContext) : '',
    profileToPrompt(options.profile, options.memories),
    STYLE_INSTRUCTIONS[options.responseStyle] || '',
    CHANNEL_INSTRUCTIONS[options.channel] || '',
    String(options.channel || '').startsWith('whatsapp') ? '' : DOCUMENTS_INSTRUCTION,
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
 * Every key of every brain provider, in the configured order (lib/brain-providers.js):
 * Groq, Cerebras, OmniRoute, OpenRouter by default. Throws CONFIGURATION when nothing is set.
 */
function providerAttempts(fastTimeoutMs, slowTimeoutMs) {
  const attempts = brainAttempts(fastTimeoutMs, slowTimeoutMs);
  if (!attempts.length) throw new AssistantResponseError('CONFIGURATION');
  return attempts;
}

/**
 * Runs the attempts in order until `run` yields a value. Another key of the same
 * provider is tried only when the failure belonged to the key (rate limit,
 * revoked); a timeout or server error means the provider itself is struggling,
 * so its remaining keys are skipped and the next provider answers instead.
 * `budgetMs` caps the whole chain (the WhatsApp nodes wait 30 s at most).
 */
async function firstSuccessful(attempts, run, { budgetMs = 0 } = {}) {
  const skipped = new Set();
  const deadline = budgetMs ? Date.now() + budgetMs : 0;
  for (const attempt of attempts) {
    if (skipped.has(attempt.provider)) continue;
    let current = attempt;
    if (deadline) {
      const remaining = deadline - Date.now();
      if (remaining < 2_000) break;
      if (remaining < attempt.timeoutMs) current = { ...attempt, timeoutMs: remaining };
    }
    const { value, status } = await run(current);
    if (value !== null && value !== undefined) return value;
    if (attempt.groq) reportGroqFailure(attempt.key, status);
    if (!isKeySpecificFailure(status)) skipped.add(attempt.provider);
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
    attempt.endpoint, attempt.key, attempt.model, messages, attempt.timeoutMs), { budgetMs: 25_000 });
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
  'إذا سأل عن رسائله ولم تجد في هذه التعليمات قائمة رسائل مرفقة، فلا تقل أبدًا إنه لا توجد رسائل؛ قل إنك لم تطّلع عليها في هذا الطلب، واطلب منه أن يقول «اعرض رسائل الواتس». ولا تستدعِ أداة الإرسال لطلب قراءة أو اطلاع.',
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
  const hasWhatsApp = tools.some((tool) => tool?.function?.name === WHATSAPP_SEND_TOOL.function.name);
  const instructions = [
    hasWhatsApp ? TOOLS_INSTRUCTION : (options.whatsappLinked === false ? WHATSAPP_UNLINKED_INSTRUCTION : ''),
    ...(Array.isArray(options.toolInstructions) ? options.toolInstructions : []),
  ].filter((line) => typeof line === 'string' && line);
  if (instructions.length) messages[0] = { role: 'system', content: `${messages[0].content}\n\n${instructions.join('\n')}` };
  const body = { messages, tools, tool_choice: 'auto' };
  const turn = await firstSuccessful(attempts, (attempt) => requestChat(
    attempt.endpoint, attempt.key, attempt.model, body, attempt.timeoutMs), { budgetMs: 28_000 });
  if (turn) return withVoiceRequest(turn, message);
  throw new AssistantResponseError('UPSTREAM');
}

// «أرسل له رسالة صوتية»، «فويس»، «ريكورد»، «بصوتك»…
const VOICE_REQUEST = /(صوتي|صوتيه|فويس|ريكورد|بصوت|بالصوت|اوديو|voice|audio)/;

/** Did the user ask for the message as a voice note? */
export function asksForVoice(text) {
  return VOICE_REQUEST.test(normalizeArabic(text));
}

/**
 * The model sometimes left as_voice out although the user said «صوتية», and
 * the message went as text. The user's own words decide.
 */
export function withVoiceRequest(turn, message) {
  if (!turn?.toolCalls?.length || !asksForVoice(message)) return turn;
  return {
    ...turn,
    toolCalls: turn.toolCalls.map((call) => (call.name === 'send_whatsapp_message' && !call.args?.attach_document
      ? { ...call, args: { ...call.args, as_voice: true } }
      : call)),
  };
}

/**
 * One forced tool call (no free text): the model must pick exactly one action.
 * Used by the phone agent, one call per screen. Returns the tool's arguments.
 */
export async function decideWithTool(system, user, tool, { timeoutMs = 20_000 } = {}) {
  const attempts = providerAttempts(timeoutMs, timeoutMs);
  const body = {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    tools: [tool],
    tool_choice: 'required',
    temperature: 0.1,
  };
  const turn = await firstSuccessful(attempts, async (attempt) => {
    const result = await requestChat(attempt.endpoint, attempt.key, attempt.model, body, attempt.timeoutMs);
    const call = result.value?.toolCalls?.find((item) => item.name === tool.function.name);
    return { value: call ? call.args : null, status: result.status };
  });
  if (turn) return turn;
  throw new AssistantResponseError('UPSTREAM');
}

// ---------------------------------------------------------------- web search (2026-10-22)

export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'يبحث في الويب عن معلومة حديثة أو متغيرة: أسعار، أخبار، طقس، نتائج مباريات، مواعيد، إجراءات حكومية وخطواتها ورسومها، ساعات عمل، أو أي سؤال لا تعرف جوابه بثقة.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'عبارة البحث، بالعربية أو الإنجليزية، مع المدينة أو التاريخ إن كان يهم.' },
      },
      required: ['query'],
    },
  },
};

export const WEB_SEARCH_INSTRUCTION = 'لديك أداة web_search للبحث في الويب. استخدمها لكل معلومة قد تكون تغيرت أو تحتاج مصدرًا حديثًا: الأسعار، الأخبار، الطقس، المباريات، الإجراءات الحكومية وخطواتها ورسومها، مواعيد العمل، وأي سؤال لا تعرف جوابه بثقة. لا تقل إنك لا تستطيع التصفح، ولا تخترع معلومة حديثة من ذاكرتك. لا تبحث في ما تعرفه يقينًا أو في الأحاديث العادية.';

/** Removes the model's internal citation markers like 【2†L6-L10】. */
export function cleanSearchAnswer(text) {
  return String(text || '').replace(/【[^】]*】/g, '').replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
}

/**
 * Answers `question` from a live web search: Groq's built-in browser_search on the
 * same model, else OpenRouter's web plugin (":online"). Same style, time and
 * location instructions as any answer. Throws UPSTREAM when nothing answered.
 */
export async function answerWithWebSearch(question, query, options = {}) {
  const attempts = providerAttempts(30_000, 25_000);
  const messages = buildMessages(
    query && query !== question ? `${question}\n\n(ابحث في الويب عن: ${query})` : question,
    {
      ...options,
      extraInstruction: 'أجب من نتائج البحث الحديثة فقط. اذكر الخلاصة أولًا، وإذا اختلفت المصادر أو كانت المعلومة قديمة فقل ذلك. اذكر اسم المصدر الرسمي عند الحاجة، ولا تضع روابط في رد صوتي. إن لم تجد جوابًا موثوقًا فقل ذلك بوضوح.',
    },
  );
  const answer = await firstSuccessful(attempts, async (attempt) => {
    // Only providers with a web search take part: Groq's browser_search, OpenRouter's ":online".
    if (!attempt.search) return { value: null, status: 400 };
    const result = attempt.search === 'browser_search'
      ? await requestCompletion(attempt.endpoint, attempt.key, attempt.model, messages, attempt.timeoutMs, {
        tools: [{ type: 'browser_search' }],
        tool_choice: 'required',
        reasoning_effort: 'low',
      })
      : await requestCompletion(attempt.endpoint, attempt.key, `${attempt.model}:online`, messages, attempt.timeoutMs);
    return { value: result.value ? cleanSearchAnswer(result.value) || null : null, status: result.status };
  }, { budgetMs: 45_000 });
  if (answer) return answer;
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
