import { json } from '../../../../lib/api-response';
import { authenticateRequest } from '../../../../lib/customer-access';
import {
  ADMIN_MESSAGES,
  isAdminEmail,
  mergeCustomerRows,
  validateAdminRequest,
} from '../../../../lib/admin';
import {
  createServiceClient,
  getConfiguredClusterNodes,
  releaseNodeForUser,
} from '../../../../lib/whatsapp-cluster';

export const runtime = 'edge';

// Effectively permanent: Supabase Auth refuses sign-in and token refresh while banned.
const SUSPEND_BAN = '876000h';

/**
 * Admin panel API. Only e-mails listed in ADMIN_EMAILS get past this point; the
 * service-role key never leaves the server. Admin calls are exempt from the
 * one-device lock, so the owner can use the panel from a browser and the app on the phone.
 */
async function requireAdmin(request) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return { response: json({ error: true, code: auth.code, message: auth.message }, auth.status) };
  if (!process.env.ADMIN_EMAILS) return { response: json({ error: true, code: 'NOT_CONFIGURED', message: ADMIN_MESSAGES.NOT_CONFIGURED }, 503) };
  if (!isAdminEmail(auth.user.email)) return { response: json({ error: true, code: 'NOT_ADMIN', message: ADMIN_MESSAGES.NOT_ADMIN }, 403) };
  const service = createServiceClient();
  if (!service) return { response: json({ error: true, code: 'NOT_CONFIGURED', message: ADMIN_MESSAGES.NOT_CONFIGURED }, 503) };
  return { admin: auth.user, service };
}

function failed(step, error, status = 502) {
  console.error('[Admin] action failed', { step, message: error?.message ?? null });
  return json({ error: true, code: 'FAILED', message: ADMIN_MESSAGES.FAILED }, status);
}

export async function GET(request) {
  const gate = await requireAdmin(request);
  if (gate.response) return gate.response;
  const { service, admin } = gate;

  const [usersResult, registryResult, nodesResult] = await Promise.all([
    service.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    service.from('customer_registry').select('*'),
    service.from('whatsapp_tenant_nodes').select('user_id, node_id, status'),
  ]);
  if (usersResult.error) return failed('list_users', usersResult.error);
  if (registryResult.error) return failed('list_registry', registryResult.error);
  if (nodesResult.error) return failed('list_nodes', nodesResult.error);

  return json({
    customers: mergeCustomerRows(usersResult.data.users, registryResult.data, nodesResult.data, admin.id),
    whatsappCapacity: { used: nodesResult.data.length, total: getConfiguredClusterNodes().length },
  });
}

export async function POST(request) {
  const gate = await requireAdmin(request);
  if (gate.response) return gate.response;
  const { service, admin } = gate;

  const body = await request.json().catch(() => null);
  const checked = validateAdminRequest(body, admin.id);
  if (!checked.ok) return json({ error: true, code: 'INVALID', message: checked.message }, 400);
  const { action, userId } = checked;

  try {
    if (action === 'create') {
      // Confirmed at once: no e-mail is sent (Supabase's built-in mailer only reaches team members).
      const { data, error } = await service.auth.admin.createUser({
        email: checked.email,
        password: checked.password,
        email_confirm: true,
      });
      if (error) {
        if (/already|registered|exists/i.test(error.message || '')) {
          return json({ error: true, code: 'EMAIL_EXISTS', message: ADMIN_MESSAGES.EMAIL_EXISTS }, 409);
        }
        return failed('create', error);
      }
      // The auth trigger creates the customer_registry row; this covers a database without it.
      await service.from('customer_registry').upsert({ user_id: data.user.id }, { onConflict: 'user_id', ignoreDuplicates: true });
      return json({ success: true, userId: data.user.id });
    }

    if (action === 'suspend') {
      const { error } = await service.from('customer_registry').update({ is_active: false }).eq('user_id', userId);
      if (error) return failed('suspend_registry', error);
      const ban = await service.auth.admin.updateUserById(userId, { ban_duration: SUSPEND_BAN });
      if (ban.error) return failed('suspend_ban', ban.error);
      const whatsapp = await releaseNodeForUser(service, userId);
      return json({ success: true, whatsapp });
    }

    if (action === 'activate') {
      const unban = await service.auth.admin.updateUserById(userId, { ban_duration: 'none' });
      if (unban.error) return failed('activate_unban', unban.error);
      const { error } = await service.from('customer_registry').update({ is_active: true }).eq('user_id', userId);
      if (error) return failed('activate_registry', error);
      return json({ success: true });
    }

    if (action === 'set_computer_pairing') {
      const { data, error } = await service
        .from('customer_registry')
        .update({ allow_computer_pairing: checked.allowComputerPairing })
        .eq('user_id', userId)
        .select('user_id')
        .maybeSingle();
      if (error) return failed('set_computer_pairing', error);
      if (!data) {
        return json({ error: true, code: 'CUSTOMER_NOT_FOUND', message: 'سجل العميل غير موجود.' }, 404);
      }
      return json({ success: true, allowComputerPairing: checked.allowComputerPairing });
    }

    if (action === 'reset_device') {
      const { error } = await service
        .from('customer_registry')
        .update({ device_id: null, device_bound_at: null })
        .eq('user_id', userId);
      if (error) return failed('reset_device', error);
      return json({ success: true });
    }

    if (action === 'set_password') {
      const { error } = await service.auth.admin.updateUserById(userId, { password: checked.password });
      if (error) return failed('set_password', error);
      return json({ success: true });
    }

    if (action === 'disconnect_whatsapp') {
      const whatsapp = await releaseNodeForUser(service, userId);
      return json({ success: true, whatsapp });
    }

    if (action === 'delete') {
      // Free the WhatsApp node first: deleting the user cascades the row away without wiping the node.
      const whatsapp = await releaseNodeForUser(service, userId);
      const { error } = await service.auth.admin.deleteUser(userId);
      if (error) return failed('delete', error);
      return json({ success: true, whatsapp });
    }
  } catch (error) {
    return failed(action, error);
  }
  return json({ error: true, code: 'INVALID', message: 'إجراء غير معروف.' }, 400);
}
