const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'openai/gpt-oss-120b';
const SYSTEM_MESSAGE = `أنت المساعد الشخصي الذكي Smart.z: مساعد حاضر، ودود، وحيوي بطبيعية ومن دون تكلّف. افهم العربية ولهجاتها جيدًا، وأجب بلغة المستخدم، وبالعربية عندما يكتب بالعربية.

اجعل الحوار خفيفًا وسهل الاستماع: ابدأ بالإجابة مباشرة، واستخدم جملًا قصيرة مترابطة وكلمات مألوفة. في الأسئلة اليومية، فضّل جوابًا موجزًا من جملتين أو ثلاث؛ وإذا كان الموضوع يحتاج شرحًا، قدّم الخلاصة أولًا ثم اعرض التوسّع. تجنّب المقدمات المحفوظة، وتكرار عبارات مثل «بالطبع» و«يسعدني مساعدتك»، والحشو، والقوائم الطويلة ما لم تطلبها الحاجة. نوّع بدايات الردود وإيقاع صياغتها، وأظهر الحماس باعتدال عندما يناسب الموقف. كن هادئًا ومتعاطفًا في المواضيع الحساسة، ومهنيًا من دون جمود.

حافظ على الدقة: لا تخترع معلومات غير معروفة، ووضّح ما لا تعرفه عند الحاجة. لا تذكر تفاصيل تقنية داخلية إلا إذا كانت ضرورية، ولا تدّع تنفيذ أي إجراء لم تنفذه فعليًا.`;

export class AssistantResponseError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function requestOpenRouterReply(message) {
  const apiKeys = [
    process.env.OPENROUTER_API_KEY,
    process.env.OPENROUTER_API_KEY_BACKUP,
  ].filter(Boolean);
  if (apiKeys.length === 0) throw new AssistantResponseError('UPSTREAM');

  for (const apiKey of apiKeys) {
    let response;
    try {
      response = await fetch(OPENROUTER_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_MESSAGE },
            { role: 'user', content: message },
          ],
        }),
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      });
    } catch {
      continue;
    }

    if (!response.ok) continue;

    let result;
    try {
      result = await response.json();
    } catch {
      continue;
    }

    const reply = result?.choices?.[0]?.message?.content;
    if (typeof reply === 'string' && reply.trim()) return reply.trim();
  }

  throw new AssistantResponseError('UPSTREAM');
}

export async function generateAssistantReply(message) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const hasOpenRouterKey = process.env.OPENROUTER_API_KEY
      || process.env.OPENROUTER_API_KEY_BACKUP;
    if (!hasOpenRouterKey) throw new AssistantResponseError('CONFIGURATION');
    return requestOpenRouterReply(message);
  }

  let response;
  try {
    response = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_MESSAGE },
          { role: 'user', content: message },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    });
  } catch {
    return requestOpenRouterReply(message);
  }

  if (!response.ok) return requestOpenRouterReply(message);

  let result;
  try {
    result = await response.json();
  } catch {
    return requestOpenRouterReply(message);
  }

  const reply = result?.choices?.[0]?.message?.content;
  if (typeof reply !== 'string' || !reply.trim()) {
    return requestOpenRouterReply(message);
  }

  return reply.trim();
}
