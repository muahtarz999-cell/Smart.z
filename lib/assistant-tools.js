/**
 * Tools the assistant can call besides WhatsApp (owner request 2026-10-22):
 *   computer_task      → a task for the paired Windows computer (needs a tap to approve on the phone)
 *   phone_action       → an Android/iOS system action (open an app, dial, SMS draft, alarm, …)
 *   control_phone_app  → step-by-step control of any app through the Android accessibility service
 *
 * The model only proposes; these planners validate the arguments and turn them
 * into an `action` the app executes. Pure functions, so they are testable.
 */
import { COMPUTER_TASK_TYPES, validateComputerTask } from './computer-task-validation.mjs';
import { sanitizeCoords, timeInstruction } from './assistant-context.js';

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// ---------------------------------------------------------------- computer

export const COMPUTER_TASK_TOOL = {
  type: 'function',
  function: {
    name: 'computer_task',
    description: 'يطلب مهمة من كمبيوتر المستخدم المربوط (Windows). لا تُنفَّذ إلا بعد موافقته من الشاشة. استخدمه عندما يطلب شيئًا على «الكمبيوتر» أو «اللابتوب».',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: COMPUTER_TASK_TYPES,
          description: 'list_files: عرض محتويات مجلد. search_files: البحث عن ملف بالاسم. file_metadata: معلومات ملف. transfer_file: نسخ ملف. open_file: فتح ملف بالبرنامج الافتراضي. open_url: فتح رابط في متصفح الكمبيوتر. open_app: تشغيل برنامج أضافه المستخدم في تطبيق الكمبيوتر. run_command: تنفيذ أمر أضافه المستخدم في تطبيق الكمبيوتر.',
        },
        path: { type: 'string', description: 'مسار نسبي داخل المجلد المسموح، مثل "Reports\\\\2026.pdf". فارغ للمجلد الرئيسي.' },
        query: { type: 'string', description: 'جزء من اسم الملف المطلوب البحث عنه (search_files).' },
        destination_path: { type: 'string', description: 'مسار النسخة الجديدة النسبي (transfer_file).' },
        url: { type: 'string', description: 'الرابط الكامل يبدأ بـ https:// (open_url).' },
        name: { type: 'string', description: 'اسم البرنامج أو الأمر كما قاله المستخدم (open_app / run_command).' },
      },
      required: ['action'],
    },
  },
};

export const COMPUTER_INSTRUCTION = 'كمبيوتر المستخدم مربوط بالتطبيق، ولديك أداة computer_task لطلب مهام منه: عرض الملفات والبحث عنها ونسخها وفتحها، فتح روابط، وتشغيل البرامج والأوامر التي أضافها المستخدم في تطبيق الكمبيوتر. كل مهمة تنتظر موافقته من الشاشة، فلا تقل إنها نُفذت؛ قل إنك أرسلتها وتنتظر موافقته.';

/**
 * args from the model + the folder the phone remembered → { taskType, payload } or { reply } when it cannot be built.
 */
export function planComputerTask(args, { authorizedRoot = '' } = {}) {
  const taskType = text(args?.action, 40);
  if (!COMPUTER_TASK_TYPES.includes(taskType)) return { reply: 'ما فهمت المطلوب على الكمبيوتر. وضّح لي ماذا أفعل.' };

  const path = text(args?.path, 512).replace(/^[\\/]+/, '');
  const root = text(authorizedRoot, 512);
  const payload = {
    list_files: () => ({ authorizedRoot: root, ...(path ? { path } : {}) }),
    search_files: () => ({ authorizedRoot: root, ...(path ? { path } : {}), query: text(args?.query, 256) }),
    file_metadata: () => ({ authorizedRoot: root, path }),
    open_file: () => ({ authorizedRoot: root, path }),
    transfer_file: () => ({ authorizedRoot: root, sourcePath: path, destinationPath: text(args?.destination_path, 512).replace(/^[\\/]+/, '') }),
    open_url: () => ({ url: text(args?.url, 2048) }),
    open_app: () => ({ appName: text(args?.name, 64) }),
    run_command: () => ({ commandName: text(args?.name, 64) }),
  }[taskType]();

  if ('authorizedRoot' in payload && !root) {
    return { reply: 'حدد أولًا مجلد الكمبيوتر المسموح من القائمة ← ربط الكمبيوتر ← مهام الكمبيوتر، ثم أعد الطلب.' };
  }
  const invalid = validateComputerTask(taskType, payload);
  if (invalid) return { reply: `ما قدرت أجهّز مهمة الكمبيوتر: ${invalid}` };
  return { taskType, payload };
}

// ---------------------------------------------------------------- phone system actions

export const PHONE_ACTIONS = Object.freeze([
  'open_app', 'call', 'sms', 'alarm', 'timer', 'calendar_event', 'navigate', 'open_url', 'web_search', 'open_settings',
]);
export const SETTINGS_SECTIONS = Object.freeze(['wifi', 'bluetooth', 'display', 'sound', 'battery', 'location', 'apps', 'accessibility', 'general']);

export const PHONE_ACTION_TOOL = {
  type: 'function',
  function: {
    name: 'phone_action',
    description: 'ينفذ إجراء نظام على هاتف المستخدم: فتح تطبيق مثبت، الاتصال، رسالة SMS، منبه، مؤقت، موعد في التقويم، الملاحة إلى مكان، فتح رابط، بحث في الويب، أو فتح إعدادات.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: PHONE_ACTIONS },
        app_name: { type: 'string', description: 'اسم التطبيق كما يظهر على الهاتف (open_app).' },
        recipient: { type: 'string', description: 'رقم الهاتف أو اسم جهة الاتصال كما قاله المستخدم (call / sms).' },
        message: { type: 'string', description: 'نص رسالة SMS (sms).' },
        hour: { type: 'integer', description: 'الساعة 0-23 (alarm).' },
        minute: { type: 'integer', description: 'الدقيقة 0-59 (alarm).' },
        seconds: { type: 'integer', description: 'مدة المؤقت بالثواني (timer).' },
        label: { type: 'string', description: 'اسم المنبه أو المؤقت.' },
        title: { type: 'string', description: 'عنوان الموعد (calendar_event).' },
        start: { type: 'string', description: 'بداية الموعد بصيغة ISO 8601 مع المنطقة الزمنية (calendar_event).' },
        end: { type: 'string', description: 'نهاية الموعد بصيغة ISO 8601 (اختياري).' },
        location: { type: 'string', description: 'مكان الموعد (اختياري).' },
        destination: { type: 'string', description: 'الوجهة للملاحة (navigate).' },
        url: { type: 'string', description: 'رابط يبدأ بـ https:// (open_url).' },
        query: { type: 'string', description: 'نص البحث (web_search).' },
        section: { type: 'string', enum: SETTINGS_SECTIONS, description: 'قسم الإعدادات (open_settings).' },
      },
      required: ['action'],
    },
  },
};

export const PHONE_ACTION_INSTRUCTION = 'لديك أداة phone_action لإجراءات الهاتف: فتح أي تطبيق مثبت، الاتصال، تجهيز رسالة SMS، ضبط منبه أو مؤقت، إضافة موعد للتقويم، الملاحة، فتح رابط، البحث في الويب، وفتح الإعدادات. استدعها مباشرة عند الطلب. الاتصال ورسالة SMS يفتحان جاهزين ويضغط المستخدم بنفسه زر الاتصال أو الإرسال، فلا تقل إنك اتصلت أو أرسلت. التاريخ والوقت الحاليان يصلانك في التعليمات؛ احسب منهما مواعيد مثل «بكرة الساعة ٥».';

const ACTION_REPLIES = {
  open_app: (a) => `أفتح ${a.appName}.`,
  call: (a) => `جهّزت الاتصال بـ${a.recipient}، اضغط زر الاتصال.`,
  sms: (a) => `جهّزت رسالة إلى ${a.recipient}، راجعها واضغط إرسال.`,
  alarm: (a) => `ضبطت منبهًا الساعة ${String(a.hour).padStart(2, '0')}:${String(a.minute).padStart(2, '0')}.`,
  timer: (a) => `شغّلت مؤقتًا ${a.seconds >= 60 ? `${Math.round(a.seconds / 60)} دقيقة` : `${a.seconds} ثانية`}.`,
  calendar_event: (a) => `جهّزت موعد «${a.title}» في التقويم، احفظه من الشاشة.`,
  navigate: (a) => `أفتح الطريق إلى ${a.destination}.`,
  open_url: () => 'أفتح الرابط.',
  web_search: (a) => `أبحث عن ${a.query}.`,
  open_settings: () => 'أفتح الإعدادات.',
};

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** args → { reply, action } where action.type === 'device_action', or { reply } asking for what is missing. */
export function planPhoneAction(args) {
  const kind = text(args?.action, 40);
  if (!PHONE_ACTIONS.includes(kind)) return { reply: 'ما فهمت الإجراء المطلوب على الهاتف.' };
  let action;
  switch (kind) {
    case 'open_app': {
      const appName = text(args?.app_name, 80);
      if (!appName) return { reply: 'أي تطبيق أفتح؟' };
      action = { appName };
      break;
    }
    case 'call':
    case 'sms': {
      const recipient = text(args?.recipient, 80);
      if (!recipient) return { reply: kind === 'call' ? 'بمن أتصل؟' : 'لمن الرسالة؟' };
      action = { recipient, ...(kind === 'sms' ? { message: text(args?.message, 1000) } : {}) };
      break;
    }
    case 'alarm': {
      const hour = Number(args?.hour);
      const minute = Number(args?.minute ?? 0);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        return { reply: 'متى أضبط المنبه؟' };
      }
      action = { hour, minute, label: text(args?.label, 60) };
      break;
    }
    case 'timer': {
      const seconds = Number(args?.seconds);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) return { reply: 'كم مدة المؤقت؟' };
      action = { seconds, label: text(args?.label, 60) };
      break;
    }
    case 'calendar_event': {
      const title = text(args?.title, 120);
      const start = Date.parse(text(args?.start, 40));
      if (!title || !Number.isFinite(start)) return { reply: 'وش عنوان الموعد ومتى؟' };
      const parsedEnd = Date.parse(text(args?.end, 40));
      const end = Number.isFinite(parsedEnd) && parsedEnd > start ? parsedEnd : start + 60 * 60 * 1000;
      action = { title, start: new Date(start).toISOString(), end: new Date(end).toISOString(), location: text(args?.location, 200) };
      break;
    }
    case 'navigate': {
      const destination = text(args?.destination, 200);
      if (!destination) return { reply: 'إلى أين؟' };
      action = { destination };
      break;
    }
    case 'open_url': {
      const url = text(args?.url, 2048);
      if (!validHttpUrl(url)) return { reply: 'الرابط غير واضح.' };
      action = { url };
      break;
    }
    case 'web_search': {
      const query = text(args?.query, 300);
      if (!query) return { reply: 'عن ماذا أبحث؟' };
      action = { query };
      break;
    }
    case 'open_settings': {
      const section = SETTINGS_SECTIONS.includes(args?.section) ? args.section : 'general';
      action = { section };
      break;
    }
    default:
      return { reply: 'ما فهمت الإجراء المطلوب على الهاتف.' };
  }
  const full = { type: 'device_action', action: kind, ...action };
  return { reply: ACTION_REPLIES[kind](full), action: full };
}

// ---------------------------------------------------------------- control any app (Android accessibility)

export const PHONE_CONTROL_TOOL = {
  type: 'function',
  function: {
    name: 'control_phone_app',
    description: 'يتحكم في أي تطبيق على هاتف Android خطوة بخطوة (يقرأ الشاشة ويضغط ويكتب) لإنجاز مهمة داخل التطبيق، مثل: «افتح يوتيوب وابحث عن…» أو «في تطبيق كذا افتح الإعدادات وفعّل…». لا تستخدمه لما تكفيه phone_action.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'المهمة كاملة وواضحة كما يريدها المستخدم.' },
        app_name: { type: 'string', description: 'اسم التطبيق الذي تبدأ منه المهمة إن ذكره.' },
      },
      required: ['goal'],
    },
  },
};

export const PHONE_CONTROL_INSTRUCTION = 'لديك أداة control_phone_app للتحكم في أي تطبيق على هذا الهاتف خطوة بخطوة بإذن إمكانية الوصول الذي منحه المستخدم. استخدمها للمهام داخل التطبيقات. لن تُدخل كلمات مرور ولن تؤكد دفعًا أو شراءً أو حذفًا؛ تتوقف قبلها ليكمل المستخدم بنفسه.';

export function planPhoneControl(args) {
  const goal = text(args?.goal, 500);
  if (!goal) return { reply: 'وش المهمة اللي تبيني أسويها في الجوال؟' };
  const appName = text(args?.app_name, 80);
  return {
    reply: `أبدأ${appName ? ` في ${appName}` : ''}: ${goal}. أقدر أوقف في أي وقت من الإشعار.`,
    action: { type: 'phone_agent', goal, appName },
  };
}

// ---------------------------------------------------------------- capabilities sent by the app

/** What the app says it can do; anything else from the client is ignored. */
export function sanitizeCapabilities(value) {
  const capabilities = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    phoneActions: capabilities.phoneActions === true,
    phoneControl: capabilities.phoneControl === true,
    phoneControlEnabled: capabilities.phoneControl === true && capabilities.phoneControlEnabled === true,
    computerRoot: text(capabilities.computerRoot, 512),
    timeZone: validTimeZone(capabilities.timeZone) ? capabilities.timeZone : 'Asia/Riyadh',
    coords: sanitizeCoords(capabilities.coords), // only when the user turned precise location on
  };
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Current date/time for the user (kept for older callers; see assistant-context.js). */
export function nowInstruction(now = new Date(), timeZone = 'Asia/Riyadh') {
  return timeInstruction(now, timeZone);
}
