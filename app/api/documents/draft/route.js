import { json } from '../../../../lib/api-response';
import { AssistantResponseError, completeWithSystem } from '../../../../lib/assistant-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../lib/customer-access';
import { getTemplate } from '../../../../lib/document-templates';

export const runtime = 'edge';

const FORMAT_RULES = `اكتب المستند بالعربية الفصحى بهذا التنسيق فقط:
- السطر الأول: "# " ثم عنوان المستند.
- العناوين الفرعية: "## ".
- البنود المرقمة: "1. " "2. " ...
- النقاط: "- ".
- التشديد: **نص**.
- سطر فارغ بين الفقرات.
لا تضف شرحاً قبل المستند أو بعده، ولا تستخدم جداول أو روابط.`;

const CONTRACT_RULES = `أنت كاتب عقود محترف. اكتب مسودة عقد واضحة ومتوازنة بين الطرفين، مع مراعاة الأنظمة المعمول بها في المملكة العربية السعودية ما لم يُذكر غير ذلك.
- استخدم البيانات المعطاة كما هي، وضع "____" مكان أي بيان ناقص.
- اذكر التاريخ بالهجري والميلادي إن أمكن، أو اترك فراغاً لهما.
- اختم بخانات التوقيع والتاريخ لكل طرف.
- لا تضف تنبيهاً قانونياً؛ التطبيق يضيفه.`;

const TEXT = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Drafts or revises a document. Nothing is stored here; the device keeps the document.
export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  const template = getTemplate(body?.templateId);
  const instruction = TEXT(body?.instruction, 3000);
  const currentBody = TEXT(body?.currentBody, 30_000);
  const fields = body?.fields && typeof body.fields === 'object' ? body.fields : {};
  if (!template && !instruction) return json({ error: true, message: 'اكتب ما تريد، أو اختر قالباً.' }, 400);

  const system = [template?.contract ? CONTRACT_RULES : 'أنت كاتب محترف للمستندات والخطابات والتقارير بالعربية.', FORMAT_RULES].join('\n\n');
  const parts = [];
  if (currentBody) {
    parts.push(`هذا هو المستند الحالي:\n${currentBody}`, `المطلوب: ${instruction || 'حسّن الصياغة دون تغيير المعنى'}`,
      'أعد المستند كاملاً بعد التعديل، وغيّر فقط ما طُلب.');
  } else {
    if (template) {
      parts.push(`نوع المستند: ${template.title}`, `الهيكل المطلوب: ${template.structure}`, 'البيانات:');
      for (const field of template.fields) parts.push(`- ${field.label}: ${TEXT(fields[field.id], 1500) || '____'}`);
    }
    if (instruction) parts.push(`تعليمات المستخدم: ${instruction}`);
  }

  try {
    const draft = await completeWithSystem(system, parts.join('\n'), { timeoutMs: 45_000 });
    const clean = draft.replace(/^```[a-z]*\n?|```$/g, '').trim();
    const title = clean.match(/^#\s+(.+)$/m)?.[1]?.trim() || template?.title || 'مستند';
    return json({ title: title.slice(0, 120), body: clean });
  } catch (error) {
    const code = error instanceof AssistantResponseError ? error.code : 'UNEXPECTED';
    console.error('[Documents API] draft failed', { code });
    return json({ error: true, message: 'تعذر كتابة المستند الآن.' }, code === 'CONFIGURATION' ? 503 : 502);
  }
}
