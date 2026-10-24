const MAX_REQUEST_BYTES = 12 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024;
// File tasks run inside a folder the user allowed on the computer (authorizedRoot).
const FILE_TASK_TYPES = new Set([
  'list_files',
  'search_files',
  'file_metadata',
  'transfer_file',
  'open_file',
]);
// Action tasks name something the computer resolves from its own local
// allowlist (apps / commands chosen on the computer); the server never sends a path or command line.
const ACTION_TASK_TYPES = new Set([
  'open_url',
  'open_app',
  'run_command',
]);
const TASK_TYPES = new Set([...FILE_TASK_TYPES, ...ACTION_TASK_TYPES]);
export const COMPUTER_TASK_TYPES = Object.freeze([...TASK_TYPES]);

// open_file must open documents, not start programs or scripts.
const BLOCKED_OPEN_EXTENSIONS = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|lnk|hta|cpl|jar|reg|application|appref-ms|url|scf|inf|sys|dll)$/i;

function validLocalName(value) {
  return typeof value === 'string' &&
    value.trim().length >= 1 &&
    value.length <= 64 &&
    !/[\x00-\x1f]/.test(value);
}

function validWebUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export const COMPUTER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isComputerUuid(value) {
  return typeof value === 'string' && COMPUTER_UUID_PATTERN.test(value);
}

export function computerAccessFailure(access) {
  if (!access?.ok) {
    return {
      error: true,
      code: access?.code || 'AUTH_REQUIRED',
      message: access?.message || 'تعذر التحقق من صلاحية الحساب.',
      status: Number.isInteger(access?.status) ? access.status : 401,
    };
  }

  if (access.customer?.allow_computer_pairing !== true) {
    return {
      error: true,
      code: 'COMPUTER_PAIRING_NOT_ALLOWED',
      message: 'ربط الكمبيوتر غير مسموح لهذا الحساب حاليًا.',
      status: 403,
    };
  }

  return null;
}

export async function readComputerJson(request) {
  const contentLength = request.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES) {
    return { ok: false, code: 'BODY_TOO_LARGE' };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, code: 'INVALID_JSON' };

  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return { ok: false, code: 'BODY_TOO_LARGE' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: 'BODY_READ_FAILED' };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, code: 'INVALID_JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'INVALID_JSON' };
  }

  return { ok: true, value: parsed };
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function validWindowsRoot(value) {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > 512 ||
    !/^[a-zA-Z]:[\\/]/.test(value) ||
    value.includes('\0') ||
    /[\x00-\x1f<>:"|?*]/.test(value.slice(3))
  ) {
    return false;
  }

  const segments = value.slice(3).split(/[\\/]+/);
  return segments.length > 0 &&
    segments.every((segment) =>
      segment &&
      segment !== '.' &&
      segment !== '..' &&
      !/[. ]$/.test(segment) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
    );
}

function validRelativePath(value, { optional = false } = {}) {
  if (value === undefined && optional) return true;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-zA-Z]:/.test(value) ||
    /[\x00-\x1f<>:"|?*]/.test(value)
  ) {
    return false;
  }

  return value.split(/[\\/]/).every((segment) =>
    segment &&
    segment !== '.' &&
    segment !== '..' &&
    !/[. ]$/.test(segment) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
  );
}

function validBoundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function validateComputerTask(taskType, payload) {
  if (!TASK_TYPES.has(taskType)) return 'نوع المهمة غير مسموح.';
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'بيانات المهمة غير صالحة.';
  }

  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return 'بيانات المهمة غير صالحة.';
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) {
    return 'حجم بيانات المهمة أكبر من المسموح.';
  }
  const allowedKeys = {
    list_files: ['authorizedRoot', 'path', 'maxEntries'],
    search_files: ['authorizedRoot', 'path', 'query', 'maxResults'],
    file_metadata: ['authorizedRoot', 'path'],
    transfer_file: ['authorizedRoot', 'sourcePath', 'destinationPath'],
    open_file: ['authorizedRoot', 'path'],
    open_url: ['url'],
    open_app: ['appName'],
    run_command: ['commandName'],
  }[taskType];
  if (!hasOnlyKeys(payload, allowedKeys)) return 'تحتوي بيانات المهمة على حقول غير مسموحة.';

  if (taskType === 'open_url') {
    return validWebUrl(payload.url) ? null : 'الرابط غير صالح؛ يُسمح بروابط http وhttps فقط.';
  }
  if (taskType === 'open_app') {
    return validLocalName(payload.appName) ? null : 'اسم البرنامج غير صالح.';
  }
  if (taskType === 'run_command') {
    return validLocalName(payload.commandName) ? null : 'اسم الأمر غير صالح.';
  }

  if (!validWindowsRoot(payload.authorizedRoot)) {
    return 'يجب تحديد مجلد Windows محلي صراحةً.';
  }

  if (taskType === 'list_files') {
    if (!validRelativePath(payload.path, { optional: true })) {
      return 'المسار النسبي غير صالح.';
    }
    if (payload.maxEntries !== undefined && !validBoundedInteger(payload.maxEntries, 1, 500)) {
      return 'عدد الملفات المطلوب غير صالح.';
    }
  }

  if (taskType === 'search_files') {
    if (
      !validRelativePath(payload.path, { optional: true }) ||
      typeof payload.query !== 'string' ||
      payload.query.trim().length === 0 ||
      payload.query.length > 256 ||
      /[\x00-\x1f]/.test(payload.query)
    ) {
      return 'بيانات البحث غير صالحة.';
    }
    if (payload.maxResults !== undefined && !validBoundedInteger(payload.maxResults, 1, 100)) {
      return 'عدد نتائج البحث غير صالح.';
    }
  }

  if (taskType === 'open_file') {
    if (!validRelativePath(payload.path)) return 'المسار النسبي غير صالح.';
    if (BLOCKED_OPEN_EXTENSIONS.test(payload.path)) return 'لا يُسمح بفتح البرامج أو السكربتات كملفات؛ استخدم أمرًا معتمدًا على الكمبيوتر.';
  }

  if (taskType === 'file_metadata' && !validRelativePath(payload.path)) {
    return 'المسار النسبي غير صالح.';
  }

  if (
    taskType === 'transfer_file' &&
    (
      !validRelativePath(payload.sourcePath) ||
      !validRelativePath(payload.destinationPath) ||
      payload.sourcePath.toLowerCase() === payload.destinationPath.toLowerCase()
    )
  ) {
    return 'مسارات النقل غير صالحة.';
  }

  return null;
}
