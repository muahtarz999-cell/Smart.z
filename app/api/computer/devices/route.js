import { computerJson, requireComputerAccess } from '../../../../lib/computer-api';

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