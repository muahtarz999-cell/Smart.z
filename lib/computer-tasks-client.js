// Computer tasks on the phone: labels, payload building, remembered folder and
// short Arabic summaries of results (spoken or shown after the assistant asks the computer).

export const COMPUTER_ROOT_STORAGE_KEY = 'smartz-computer-root';

export const COMPUTER_TASK_LABELS = Object.freeze({
  list_files: 'عرض الملفات والمجلدات',
  search_files: 'البحث عن أسماء الملفات',
  file_metadata: 'معلومات ملف',
  transfer_file: 'نسخ ملف',
  open_file: 'فتح ملف على الكمبيوتر',
  open_url: 'فتح رابط في متصفح الكمبيوتر',
  open_app: 'تشغيل برنامج',
  run_command: 'تنفيذ أمر معتمد',
});

const ROOT_TASKS = new Set(['list_files', 'search_files', 'file_metadata', 'transfer_file', 'open_file']);

export function taskNeedsRoot(taskType) {
  return ROOT_TASKS.has(taskType);
}

export function readComputerRoot(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(COMPUTER_ROOT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function rememberComputerRoot(root, storage = globalThis.localStorage) {
  try {
    if (root) storage?.setItem(COMPUTER_ROOT_STORAGE_KEY, root);
  } catch {
    // Private mode / blocked storage: the form still works, the assistant just asks for the folder.
  }
}

/** Builds the payload the server validates (lib/computer-task-validation.mjs). */
export function buildTaskPayload(taskType, { authorizedRoot = '', path = '', query = '', destination = '', name = '', url = '' } = {}) {
  const optionalPath = path ? { path } : {};
  switch (taskType) {
    case 'list_files': return { authorizedRoot, ...optionalPath };
    case 'search_files': return { authorizedRoot, ...optionalPath, query };
    case 'file_metadata': return { authorizedRoot, path };
    case 'open_file': return { authorizedRoot, path };
    case 'transfer_file': return { authorizedRoot, sourcePath: path, destinationPath: destination };
    case 'open_url': return { url };
    case 'open_app': return { appName: name };
    case 'run_command': return { commandName: name };
    default: return {};
  }
}

/** One line describing what the computer is asked to do. */
export function describeComputerTask(task) {
  const payload = task?.payload || {};
  switch (task?.task_type) {
    case 'list_files': return `عرض محتويات ${payload.path || 'المجلد الرئيسي'}`;
    case 'search_files': return `البحث عن «${payload.query || ''}»`;
    case 'file_metadata': return `معلومات «${payload.path || ''}»`;
    case 'transfer_file': return `نسخ «${payload.sourcePath || ''}» إلى «${payload.destinationPath || ''}»`;
    case 'open_file': return `فتح «${payload.path || ''}»`;
    case 'open_url': return `فتح الرابط ${payload.url || ''}`;
    case 'open_app': return `تشغيل برنامج «${payload.appName || ''}»`;
    case 'run_command': return `تنفيذ الأمر «${payload.commandName || ''}»`;
    default: return COMPUTER_TASK_LABELS[task?.task_type] || 'مهمة كمبيوتر';
  }
}

const ERROR_TEXT = {
  APP_NOT_IN_LOCAL_LIST: 'البرنامج غير مضاف في تطبيق الكمبيوتر',
  COMMAND_NOT_IN_LOCAL_LIST: 'الأمر غير مضاف في تطبيق الكمبيوتر',
  COMMAND_TIMED_OUT: 'انتهت مهلة الأمر',
  SCOPE_NOT_AUTHORIZED: 'المسار خارج المجلدات المسموحة',
  FILE_NOT_FOUND: 'الملف غير موجود',
  DIRECTORY_NOT_FOUND: 'المجلد غير موجود',
  AGENT_STOPPED: 'أُوقف تطبيق الكمبيوتر',
};

/** Short, speakable summary of a finished task. */
export function summarizeComputerResult(task) {
  const result = task?.result || {};
  if (task?.status === 'rejected' || task?.status === 'cancelled') return 'أُلغيت مهمة الكمبيوتر.';
  if (task?.status === 'expired') return 'انتهت صلاحية مهمة الكمبيوتر قبل تنفيذها. تأكد أن تطبيق الكمبيوتر يعمل.';
  if (task?.status === 'failed') {
    const code = result.errorCode || result.code;
    const reason = ERROR_TEXT[code] || result.error || 'تعذر التنفيذ';
    const available = Array.isArray(result.available) && result.available.length
      ? ` المتاح: ${result.available.slice(0, 8).join('، ')}.` : '';
    return `لم تنجح مهمة الكمبيوتر: ${reason}.${available}`;
  }
  if (task?.status !== 'succeeded') return '';

  const items = result.items || result.entries || result.results;
  switch (task.task_type) {
    case 'list_files':
    case 'search_files': {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return task.task_type === 'search_files' ? 'لم أجد ملفات مطابقة على الكمبيوتر.' : 'المجلد فارغ.';
      const names = list.slice(0, 8).map((item) => (typeof item === 'string' ? item : item.name || item.path)).filter(Boolean);
      return `وجدت ${list.length}${list.length >= 8 ? ' أو أكثر' : ''}: ${names.join('، ')}.`;
    }
    case 'file_metadata': {
      const size = result.sizeBytes ?? result.size;
      return `«${result.path || ''}» ${result.kind === 'directory' || result.type === 'directory' ? 'مجلد' : 'ملف'}${Number.isFinite(size) ? ` حجمه ${Math.max(1, Math.round(size / 1024))} كيلوبايت` : ''}.`;
    }
    case 'transfer_file': return 'نُسخ الملف على الكمبيوتر.';
    case 'open_file': return 'فتحت الملف على الكمبيوتر.';
    case 'open_url': return 'فتحت الرابط على الكمبيوتر.';
    case 'open_app': return `شغّلت ${result.started || 'البرنامج'} على الكمبيوتر.`;
    case 'run_command': {
      const output = String(result.output || '').trim();
      return `انتهى الأمر ${result.command || ''}${result.exitCode === 0 ? ' بنجاح' : ` برمز ${result.exitCode}`}.${output ? `\n${output.slice(0, 600)}` : ''}`;
    }
    default: return 'اكتملت مهمة الكمبيوتر.';
  }
}
