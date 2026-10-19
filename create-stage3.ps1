
$ErrorActionPreference = "Stop"

$ExpectedRoot = "C:\Users\LENOVO\Desktop\Smart.z-computer-pairing"
$CurrentRoot = (Get-Location).Path

if ($CurrentRoot -ne $ExpectedRoot) {
    throw "افتح PowerShell داخل مجلد Smart.z-computer-pairing أولاً."
}

if (-not (Test-Path ".\package.json")) {
    throw "لم يتم العثور على package.json. أوقف التنفيذ."
}

function Write-NewFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath,

        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $FullPath = Join-Path $ExpectedRoot $RelativePath

    if (Test-Path -LiteralPath $FullPath) {
        throw "الملف موجود مسبقاً، لن أستبدله: $RelativePath"
    }

    $Parent = Split-Path -Parent $FullPath

    if (-not (Test-Path -LiteralPath $Parent)) {
        New-Item -ItemType Directory -Path $Parent -Force | Out-Null
    }

    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($FullPath, $Content, $Utf8NoBom)

    Write-Host "Created: $RelativePath" -ForegroundColor Green
}

Write-Host "Safety checks passed. Waiting for file definitions." -ForegroundColor Cyan

# Stage 3 - Part 2: migration draft and shared API helpers

$migration = @'
-- Local draft only. Do NOT apply to Supabase yet.
begin;

alter table public.computer_devices
  add column if not exists pairing_challenge_hash text,
  add column if not exists pairing_expires_at timestamptz;

create unique index if not exists computer_devices_pairing_challenge_hash_uidx
  on public.computer_devices(pairing_challenge_hash)
  where pairing_challenge_hash is not null;

commit;
'@

Write-NewFile `
  -RelativePath "supabase/migrations/202610180004_computer_pairing_api.sql" `
  -Content $migration

$helper = @'
import { NextResponse } from 'next/server';
import { requireCustomerRegistered } from './customer-access';
import { createServiceClient } from './whatsapp-cluster';

export function computerJson(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function requireComputerAccess(request) {
  const access = await requireCustomerRegistered(request);

  if (!access?.ok) {
    return {
      response: computerJson({
        error: true,
        code: access?.code || 'AUTH_REQUIRED',
        message: access?.message || 'تعذر التحقق من صلاحية الحساب.',
      }, access?.status || 401),
    };
  }

  if (access.customer?.allow_computer_pairing !== true) {
    return {
      response: computerJson({
        error: true,
        code: 'COMPUTER_PAIRING_NOT_ALLOWED',
        message: 'ربط الكمبيوتر غير مسموح لهذا الحساب حاليًا.',
      }, 403),
    };
  }

  const service = createServiceClient();

  if (!service) {
    return {
      response: computerJson({
        error: true,
        code: 'COMPUTER_SERVICE_UNAVAILABLE',
        message: 'خدمة ربط الكمبيوتر غير متاحة حاليًا.',
      }, 503),
    };
  }

  return { access, service };
}

export async function writeComputerAudit(
  service,
  { userId, deviceId = null, taskId = null, actorType = 'customer', eventType, details = {} }
) {
  const { error } = await service.from('computer_audit_logs').insert({
    user_id: userId,
    device_id: deviceId,
    task_id: taskId,
    actor_type: actorType,
    event_type: eventType,
    details,
  });

  if (error) {
    console.error('[Computer pairing] audit insert failed', {
      code: error.code || null,
      message: error.message || null,
      eventType,
    });
    throw new Error('COMPUTER_AUDIT_WRITE_FAILED');
  }
}

const ALLOWED_TASK_TYPES = new Set([
  'list_files',
  'search_files',
  'file_metadata',
  'transfer_file',
]);

export function validateComputerTask(taskType, payload) {
  if (!ALLOWED_TASK_TYPES.has(taskType)) {
    return 'نوع المهمة غير مسموح.';
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'بيانات المهمة غير صالحة.';
  }

  const serialized = JSON.stringify(payload);
  if (serialized.length > 8000) {
    return 'حجم بيانات المهمة أكبر من المسموح.';
  }

  for (const key of ['path', 'sourcePath', 'destinationPath']) {
    const value = payload[key];
    if (value === undefined) continue;

    if (typeof value !== 'string' || value.length > 1024) {
      return 'مسار الملف غير صالح.';
    }

    if (
      value.includes('\0') ||
      value.startsWith('/') ||
      value.startsWith('\\') ||
      /^[a-zA-Z]:/.test(value) ||
      value.split(/[\\/]+/).includes('..')
    ) {
      return 'يجب أن يكون المسار نسبيًا وألا يتجاوز المجلد المسموح.';
    }
  }

  return null;
}
'@

Write-NewFile `
  -RelativePath "lib/computer-api.js" `
  -Content $helper

Write-Host "Stage 3 part 2 added to the script." -ForegroundColor Cyan

# Stage 3 - Part 3: device and task APIs

$devicesRoute = @'
import { computerJson, requireComputerAccess, writeComputerAudit } from '../../../../lib/computer-api';

export const runtime = 'nodejs';

export async function GET(request) {
  const context = await requireComputerAccess(request);
  if (context.response) return context.response;

  const { access, service } = context;
  const { data, error } = await service
    .from('computer_devices')
    .select('id, label, status, paired_at, last_seen_at, created_at')
    .eq('user_id', access.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return computerJson({ error: true, code: 'DEVICE_LIST_FAILED', message: 'تعذر جلب أجهزة الكمبيوتر.' }, 503);
  }

  return computerJson({ devices: data || [] });
}
'@

Write-NewFile `
  -RelativePath "app/api/computer/devices/route.js" `
  -Content $devicesRoute

$deviceDetailRoute = @'
import { computerJson, requireComputerAccess, writeComputerAudit } from '../../../../../lib/computer-api';

export const runtime = 'nodejs';

export async function DELETE(request, { params }) {
  const context = await requireComputerAccess(request);
  if (context.response) return context.response;

  const { access, service } = context;
  const { deviceId } = await params;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId || '')) {
    return computerJson({ error: true, code: 'INVALID_DEVICE_ID', message: 'معرّف الجهاز غير صالح.' }, 400);
  }

  const { data: device, error: lookupError } = await service
    .from('computer_devices')
    .select('id, status')
    .eq('id', deviceId)
    .eq('user_id', access.user.id)
    .maybeSingle();

  if (lookupError) {
    return computerJson({ error: true, code: 'DEVICE_LOOKUP_FAILED', message: 'تعذر التحقق من الجهاز.' }, 503);
  }
  if (!device) {
    return computerJson({ error: true, code: 'DEVICE_NOT_FOUND', message: 'الجهاز غير موجود في حسابك.' }, 404);
  }

  const { error } = await service
    .from('computer_devices')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      pairing_challenge_hash: null,
      pairing_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', deviceId)
    .eq('user_id', access.user.id);

  if (error) {
    return computerJson({ error: true, code: 'DEVICE_REVOKE_FAILED', message: 'تعذر إلغاء ربط الجهاز.' }, 503);
  }

  try {
    await writeComputerAudit(service, {
      userId: access.user.id,
      deviceId,
      eventType: 'device_revoked',
    });
  } catch {
    return computerJson({ error: true, code: 'AUDIT_WRITE_FAILED', message: 'أُلغي الربط لكن تعذر تسجيل العملية.' }, 503);
  }

  return computerJson({ success: true });
}
'@

Write-NewFile `
  -RelativePath "app/api/computer/devices/[deviceId]/route.js" `
  -Content $deviceDetailRoute

$tasksRoute = @'
import {
  computerJson,
  requireComputerAccess,
  validateComputerTask,
  writeComputerAudit,
} from '../../../../lib/computer-api';

export const runtime = 'nodejs';

export async function GET(request) {
  const context = await requireComputerAccess(request);
  if (context.response) return context.response;

  const { access, service } = context;
  const { data, error } = await service
    .from('computer_tasks')
    .select('id, device_id, task_type, status, payload, result, expires_at, created_at, updated_at')
    .eq('user_id', access.user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    return computerJson({ error: true, code: 'TASK_LIST_FAILED', message: 'تعذر جلب المهام.' }, 503);
  }

  return computerJson({ tasks: data || [] });
}

export async function POST(request) {
  const context = await requireComputerAccess(request);
  if (context.response) return context.response;

  const { access, service } = context;
  let body;

  try {
    body = await request.json();
  } catch {
    return computerJson({ error: true, code: 'INVALID_JSON', message: 'صيغة الطلب غير صالحة.' }, 400);
  }

  const deviceId = body?.deviceId;
  const taskType = body?.taskType;
  const payload = body?.payload ?? {};

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId || '')) {
    return computerJson({ error: true, code: 'INVALID_DEVICE_ID', message: 'معرّف الجهاز غير صالح.' }, 400);
  }

  const validationError = validateComputerTask(taskType, payload);
  if (validationError) {
    return computerJson({ error: true, code: 'INVALID_TASK', message: validationError }, 400);
  }

  const { data: device, error: deviceError } = await service
    .from('computer_devices')
    .select('id')
    .eq('id', deviceId)
    .eq('user_id', access.user.id)
    .eq('status', 'active')
    .maybeSingle();

  if (deviceError) {
    return computerJson({ error: true, code: 'DEVICE_LOOKUP_FAILED', message: 'تعذر التحقق من الجهاز.' }, 503);
  }
  if (!device) {
    return computerJson({ error: true, code: 'DEVICE_NOT_ACTIVE', message: 'الجهاز غير مربوط أو غير نشط.' }, 403);
  }

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { data: task, error: taskError } = await service
    .from('computer_tasks')
    .insert({
      user_id: access.user.id,
      device_id: deviceId,
      task_type: taskType,
      status: 'awaiting_approval',
      payload,
      expires_at: expiresAt,
    })
    .select('id, device_id, task_type, status, expires_at, created_at')
    .single();

  if (taskError || !task) {
    return computerJson({ error: true, code: 'TASK_CREATE_FAILED', message: 'تعذر إنشاء المهمة.' }, 503);
  }

  const { error: approvalError } = await service
    .from('computer_task_approvals')
    .insert({
      user_id: access.user.id,
      task_id: task.id,
      decision: 'pending',
      expires_at: expiresAt,
    });

  if (approvalError) {
    await service
      .from('computer_tasks')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', task.id)
      .eq('user_id', access.user.id);

    return computerJson({ error: true, code: 'APPROVAL_CREATE_FAILED', message: 'تعذر إنشاء سجل الموافقة.' }, 503);
  }

  try {
    await writeComputerAudit(service, {
      userId: access.user.id,
      deviceId,
      taskId: task.id,
      eventType: 'task_created',
      details: { taskType },
    });
  } catch {
    return computerJson({ error: true, code: 'AUDIT_WRITE_FAILED', message: 'أُنشئت المهمة لكن تعذر تسجيل العملية.' }, 503);
  }

  return computerJson({ task }, 201);
}
'@

Write-NewFile `
  -RelativePath "app/api/computer/tasks/route.js" `
  -Content $tasksRoute

Write-Host "Stage 3 part 3 added to the script." -ForegroundColor Cyan

# Stage 3 - Part 4: explicit task approval API

$approvalRoute = @'
import {
  computerJson,
  requireComputerAccess,
  writeComputerAudit,
} from '../../../../../../lib/computer-api';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  const context = await requireComputerAccess(request);
  if (context.response) return context.response;

  const { access, service } = context;
  const { taskId } = await params;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId || '')) {
    return computerJson({
      error: true,
      code: 'INVALID_TASK_ID',
      message: 'معرّف المهمة غير صالح.',
    }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return computerJson({
      error: true,
      code: 'INVALID_JSON',
      message: 'صيغة الطلب غير صالحة.',
    }, 400);
  }

  const decision = body?.decision;
  if (!['approved', 'rejected'].includes(decision)) {
    return computerJson({
      error: true,
      code: 'INVALID_DECISION',
      message: 'يجب اختيار الموافقة أو الرفض.',
    }, 400);
  }

  const { data: task, error: taskLookupError } = await service
    .from('computer_tasks')
    .select('id, device_id, status, expires_at')
    .eq('id', taskId)
    .eq('user_id', access.user.id)
    .maybeSingle();

  if (taskLookupError) {
    return computerJson({
      error: true,
      code: 'TASK_LOOKUP_FAILED',
      message: 'تعذر التحقق من المهمة.',
    }, 503);
  }

  if (!task) {
    return computerJson({
      error: true,
      code: 'TASK_NOT_FOUND',
      message: 'المهمة غير موجودة في حسابك.',
    }, 404);
  }

  if (task.status !== 'awaiting_approval') {
    return computerJson({
      error: true,
      code: 'TASK_NOT_AWAITING_APPROVAL',
      message: 'هذه المهمة لا تنتظر الموافقة حاليًا.',
    }, 409);
  }

  const now = new Date();
  if (new Date(task.expires_at).getTime() <= now.getTime()) {
    await service
      .from('computer_tasks')
      .update({ status: 'expired', updated_at: now.toISOString() })
      .eq('id', taskId)
      .eq('user_id', access.user.id)
      .eq('status', 'awaiting_approval');

    await service
      .from('computer_task_approvals')
      .update({ decision: 'expired', decided_at: now.toISOString() })
      .eq('task_id', taskId)
      .eq('user_id', access.user.id)
      .eq('decision', 'pending');

    return computerJson({
      error: true,
      code: 'TASK_EXPIRED',
      message: 'انتهت صلاحية المهمة؛ أنشئ طلبًا جديدًا إذا لزم الأمر.',
    }, 410);
  }

  const decidedAt = now.toISOString();
  const { data: approval, error: approvalError } = await service
    .from('computer_task_approvals')
    .update({ decision, decided_at: decidedAt })
    .eq('task_id', taskId)
    .eq('user_id', access.user.id)
    .eq('decision', 'pending')
    .gt('expires_at', decidedAt)
    .select('id')
    .maybeSingle();

  if (approvalError) {
    return computerJson({
      error: true,
      code: 'APPROVAL_UPDATE_FAILED',
      message: 'تعذر تسجيل قرار الموافقة.',
    }, 503);
  }

  if (!approval) {
    return computerJson({
      error: true,
      code: 'APPROVAL_ALREADY_DECIDED',
      message: 'تم اتخاذ قرار بشأن هذه المهمة أو انتهت صلاحيتها.',
    }, 409);
  }

  const nextStatus = decision === 'approved' ? 'approved' : 'cancelled';

  const { data: updatedTask, error: updateError } = await service
    .from('computer_tasks')
    .update({ status: nextStatus, updated_at: decidedAt })
    .eq('id', taskId)
    .eq('user_id', access.user.id)
    .eq('status', 'awaiting_approval')
    .gt('expires_at', decidedAt)
    .select('id, status, device_id')
    .maybeSingle();

  if (updateError || !updatedTask) {
    return computerJson({
      error: true,
      code: 'TASK_UPDATE_FAILED',
      message: 'سُجّل القرار لكن تعذر تحديث حالة المهمة؛ يلزم فحص الحالة قبل إعادة المحاولة.',
    }, 503);
  }

  try {
    await writeComputerAudit(service, {
      userId: access.user.id,
      deviceId: task.device_id,
      taskId,
      eventType: 'approval_decided',
      details: { decision },
    });
  } catch {
    return computerJson({
      error: true,
      code: 'AUDIT_WRITE_FAILED',
      message: 'تم تحديث القرار لكن تعذر تسجيل العملية.',
    }, 503);
  }

  return computerJson({
    success: true,
    decision,
    task: updatedTask,
  });
}
'@

Write-NewFile `
  -RelativePath "app/api/computer/tasks/[taskId]/approval/route.js" `
  -Content $approvalRoute

Write-Host "All Stage 3 file definitions have been added." -ForegroundColor Cyan

