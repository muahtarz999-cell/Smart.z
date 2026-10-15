/**
 * Guided templates for documents and contracts. Shared by the app (wizard
 * questions) and the server (drafting instructions). Add a template by adding
 * an object here; no other code changes are needed.
 */

export const LEGAL_DISCLAIMER = 'تنبيه: هذه مسودة أعدّها مساعد آلي للمساعدة، وليست استشارة قانونية. راجعها مع مختص قبل التوقيع.';

const parties = (first, second) => [
  { id: 'firstParty', label: first, question: `ما اسم ${first} الكامل ورقم هويته أو سجله؟`, required: true },
  { id: 'secondParty', label: second, question: `ما اسم ${second} الكامل ورقم هويته أو سجله؟`, required: true },
];

export const DOCUMENT_TEMPLATES = [
  {
    id: 'lease', title: 'عقد إيجار سكني', contract: true,
    fields: [
      ...parties('المؤجر', 'المستأجر'),
      { id: 'property', label: 'العقار', question: 'ما وصف العقار وعنوانه (المدينة، الحي، رقم الوحدة)؟', required: true },
      { id: 'term', label: 'المدة', question: 'ما مدة العقد وتاريخ بدايته؟', required: true },
      { id: 'rent', label: 'الإيجار', question: 'كم الإيجار، وكيف يُدفع (شهري، ربع سنوي، سنوي)؟', required: true },
      { id: 'deposit', label: 'التأمين', question: 'هل يوجد مبلغ تأمين؟ كم؟' },
      { id: 'extra', label: 'شروط إضافية', question: 'هل هناك شروط أخرى (صيانة، فواتير، عدم التأجير من الباطن)؟' },
    ],
    structure: 'تمهيد بالطرفين، وصف العقار، المدة والتجديد، الأجرة وطريقة السداد، التأمين، التزامات المؤجر، التزامات المستأجر، الصيانة والخدمات، الإخلاء والإنهاء، تسوية النزاعات، النسخ والتوقيع.',
  },
  {
    id: 'employment', title: 'عقد عمل', contract: true,
    fields: [
      ...parties('صاحب العمل', 'العامل'),
      { id: 'position', label: 'المسمى الوظيفي', question: 'ما المسمى الوظيفي ومكان العمل؟', required: true },
      { id: 'salary', label: 'الأجر', question: 'كم الراتب الأساسي والبدلات؟', required: true },
      { id: 'term', label: 'المدة', question: 'هل العقد محدد المدة أم غير محدد؟ وما تاريخ المباشرة؟', required: true },
      { id: 'probation', label: 'فترة التجربة', question: 'كم فترة التجربة؟' },
      { id: 'hours', label: 'ساعات العمل والإجازات', question: 'ما ساعات العمل الأسبوعية والإجازة السنوية؟' },
    ],
    structure: 'الطرفان، طبيعة العمل ومكانه، مدة العقد وفترة التجربة، الأجر والبدلات وموعد صرفه، ساعات العمل والراحة، الإجازات، الالتزامات، السرية، إنهاء العقد ومكافأة نهاية الخدمة، النظام الواجب التطبيق، التوقيع.',
  },
  {
    id: 'sale', title: 'عقد بيع', contract: true,
    fields: [
      ...parties('البائع', 'المشتري'),
      { id: 'item', label: 'المبيع', question: 'ما الشيء المبيع ووصفه (مثلاً سيارة: النوع، الموديل، رقم الهيكل، اللوحة)؟', required: true },
      { id: 'price', label: 'الثمن', question: 'كم الثمن وطريقة الدفع؟', required: true },
      { id: 'delivery', label: 'التسليم', question: 'متى وأين يتم التسليم؟' },
      { id: 'warranty', label: 'الضمان والحالة', question: 'هل يوجد ضمان أو عيوب معروفة يقر بها المشتري؟' },
    ],
    structure: 'الطرفان، وصف المبيع، الثمن وطريقة السداد، التسليم ونقل الملكية، حالة المبيع والضمان، الإقرار بالمعاينة، تسوية النزاعات، التوقيع.',
  },
  {
    id: 'services', title: 'عقد تقديم خدمات', contract: true,
    fields: [
      ...parties('مقدم الخدمة', 'العميل'),
      { id: 'scope', label: 'نطاق العمل', question: 'ما الخدمة المطلوبة بالتفصيل؟', required: true },
      { id: 'deliverables', label: 'التسليمات والمدة', question: 'ما التسليمات ومواعيدها؟', required: true },
      { id: 'fee', label: 'المقابل', question: 'كم المقابل ومتى يُدفع (دفعات)؟', required: true },
      { id: 'termination', label: 'الإنهاء', question: 'ما شروط الإنهاء أو التعديل؟' },
    ],
    structure: 'الطرفان، التعريفات، نطاق الخدمات، التسليمات والجدول الزمني، المقابل والدفعات، الالتزامات، الملكية الفكرية، السرية، الإنهاء، المسؤولية، تسوية النزاعات، التوقيع.',
  },
  {
    id: 'nda', title: 'اتفاقية عدم إفصاح', contract: true,
    fields: [
      ...parties('الطرف المفصح', 'الطرف المتلقي'),
      { id: 'purpose', label: 'الغرض', question: 'ما الغرض من مشاركة المعلومات؟', required: true },
      { id: 'duration', label: 'مدة السرية', question: 'كم مدة الالتزام بالسرية؟', required: true },
      { id: 'exceptions', label: 'الاستثناءات', question: 'هل هناك معلومات مستثناة؟' },
    ],
    structure: 'الطرفان، الغرض، تعريف المعلومات السرية، الاستثناءات، التزامات المتلقي، المدة، إعادة المعلومات أو إتلافها، الجزاءات، النظام الواجب التطبيق، التوقيع.',
  },
  {
    id: 'letter', title: 'خطاب رسمي', contract: false,
    fields: [
      { id: 'to', label: 'المرسل إليه', question: 'لمن الخطاب (الاسم والصفة والجهة)؟', required: true },
      { id: 'subject', label: 'الموضوع', question: 'ما موضوع الخطاب؟', required: true },
      { id: 'request', label: 'المضمون', question: 'ماذا تريد أن تقول أو تطلب بالتفصيل؟', required: true },
      { id: 'from', label: 'المرسل', question: 'ما اسمك وصفتك للتوقيع؟', required: true },
    ],
    structure: 'التاريخ، المرسل إليه، الموضوع، التحية، المقدمة، صلب الطلب، الختام، التوقيع.',
  },
  {
    id: 'cv', title: 'سيرة ذاتية', contract: false,
    fields: [
      { id: 'personal', label: 'البيانات', question: 'اسمك، رقمك، بريدك، مدينتك؟', required: true },
      { id: 'summary', label: 'نبذة', question: 'نبذة مختصرة عنك وعن هدفك المهني؟' },
      { id: 'experience', label: 'الخبرات', question: 'خبراتك العملية: الجهة، المسمى، الفترة، أبرز المهام؟', required: true },
      { id: 'education', label: 'التعليم', question: 'مؤهلاتك الدراسية؟', required: true },
      { id: 'skills', label: 'المهارات واللغات', question: 'مهاراتك واللغات والشهادات؟' },
    ],
    structure: 'الاسم وبيانات التواصل، النبذة، الخبرات العملية (الأحدث أولاً)، التعليم، المهارات، اللغات، الشهادات.',
  },
];

export function getTemplate(id) {
  return DOCUMENT_TEMPLATES.find((template) => template.id === id) || null;
}

/** "اكتب لي عقد إيجار" → the lease template, for voice and typed commands. */
export function templateFromRequest(text) {
  const value = String(text || '');
  if (!/(اكتب|أكتب|سو|سوي|جهز|جهّز|أنشئ|انشئ|اعمل|أعد|ابغى|أبغى|ابي|أبي).{0,20}(عقد|اتفاقي|خطاب|سير[هة])/.test(value)) return null;
  if (/إيجار|ايجار|أجار/.test(value)) return getTemplate('lease');
  if (/عمل|توظيف|موظف/.test(value)) return getTemplate('employment');
  if (/بيع|شراء|سيار/.test(value)) return getTemplate('sale');
  if (/خدم|مقاول|تصميم|برمج/.test(value)) return getTemplate('services');
  if (/إفصاح|افصاح|سري/.test(value)) return getTemplate('nda');
  if (/سير[هة]/.test(value)) return getTemplate('cv');
  if (/خطاب/.test(value)) return getTemplate('letter');
  return null;
}
