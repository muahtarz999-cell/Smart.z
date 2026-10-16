import { json } from '../../../lib/api-response';
import { AssistantResponseError, completeWithSystem, parseJsonReply } from '../../../lib/assistant-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';
import { isUsableStudyResult, normalizeStudyResult, STUDY_TYPES } from '../../../lib/study-schema';

export const runtime = 'edge';

const MAX_SOURCE = 14_000;
const COMMON = 'أنت معلم خبير يساعد طالباً على مذاكرة مادته. اعتمد على النص المعطى فقط ولا تضف معلومات من خارجه. اكتب بلغة النص (العربية غالباً). أعد JSON فقط.';

const PROMPTS = {
  summary: ({ length }) => `${COMMON}
لخّص النص ${length === 'short' ? 'في 5 إلى 8 نقاط' : 'في 10 إلى 20 نقطة مفصلة'} مرتبة كما في النص، مع رقم الصفحة لكل نقطة إن ظهر بصيغة [صN].
الشكل: {"overview":"فقرة قصيرة عن الموضوع","points":[{"text":"...","page":3}]}`,
  explain: ({ topic }) => `${COMMON}
اشرح ${topic ? `«${topic}»` : 'النص'} شرحاً مبسطاً كأنك تشرح لطالب لأول مرة: الفكرة الأساسية، ثم مثال، ثم الخلاصة. جمل قصيرة تصلح للقراءة بصوت عالٍ، بلا رموز أو جداول.
الشكل: {"text":"..."}`,
  quiz: ({ count }) => `${COMMON}
اكتب ${count} سؤالاً متنوعاً لاختبار الفهم: أغلبها اختيار من متعدد بأربعة خيارات (answer = رقم الخيار الصحيح من 0)، وبعضها صح/خطأ (answer = true أو false)، وسؤال أو اثنان بإجابة قصيرة (answer = نص). لكل سؤال شرح قصير للإجابة ورقم الصفحة إن ظهر.
الشكل: {"questions":[{"type":"mcq","question":"...","options":["...","...","...","..."],"answer":1,"explanation":"...","page":2},{"type":"tf","question":"...","answer":true,"explanation":"..."},{"type":"short","question":"...","answer":"...","explanation":"..."}]}`,
  cards: ({ count }) => `${COMMON}
اكتب ${count} بطاقة مراجعة: الوجه سؤال أو مصطلح قصير، والظهر إجابة أو تعريف مختصر ودقيق، مع رقم الصفحة إن ظهر.
الشكل: {"cards":[{"front":"...","back":"...","page":4}]}`,
  mindmap: () => `${COMMON}
ابنِ خريطة ذهنية: الموضوع الرئيسي، ثم 4 إلى 8 فروع، ولكل فرع 2 إلى 6 أفكار قصيرة.
الشكل: {"root":"...","branches":[{"title":"...","children":["...","..."]}]}`,
};

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  const type = STUDY_TYPES.includes(body?.type) ? body.type : null;
  if (!type) return json({ error: true, message: 'نوع الأداة غير صالح.' }, 400);

  let source = '';
  for (const passage of Array.isArray(body.passages) ? body.passages : []) {
    const textValue = typeof passage?.text === 'string' ? passage.text.trim() : '';
    if (!textValue) continue;
    const line = `${Number.isInteger(passage.page) ? `[ص${passage.page}] ` : ''}${textValue}\n`;
    if (source.length + line.length > MAX_SOURCE) break;
    source += line;
  }
  if (!source) return json({ error: true, message: 'لا يوجد نص للمذاكرة منه.' }, 400);

  const options = {
    length: body.options?.length === 'short' ? 'short' : 'long',
    count: Math.min(30, Math.max(3, Number(body.options?.count) || 10)),
    topic: typeof body.options?.topic === 'string' ? body.options.topic.trim().slice(0, 200) : '',
  };

  try {
    const reply = await completeWithSystem(PROMPTS[type](options), `النص (${String(body.scopeLabel || '').slice(0, 80)}):\n${source}`, { json: true, timeoutMs: 45_000 });
    const result = normalizeStudyResult(type, parseJsonReply(reply));
    if (!isUsableStudyResult(type, result)) return json({ error: true, message: 'لم تصل نتيجة صالحة، أعد المحاولة.' }, 502);
    return json({ type, result });
  } catch (error) {
    const code = error instanceof AssistantResponseError ? error.code : 'UNEXPECTED';
    console.error('[Study API] failed', { code, type });
    return json({ error: true, message: 'تعذر تجهيز أداة المذاكرة الآن.' }, code === 'CONFIGURATION' ? 503 : 502);
  }
}
