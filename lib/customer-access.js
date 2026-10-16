import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { decideDevice, DEVICE_MESSAGES, readDeviceHeader } from './device-lock';

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

export async function authenticateRequest(request) {
  const authorization = request.headers.get('authorization') || '';
  const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) return failure(503, 'AUTH_UNAVAILABLE', 'خدمة تسجيل الدخول غير متاحة.');
  if (!accessToken) return failure(401, 'AUTH_REQUIRED', 'سجّل الدخول للمتابعة.');

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  let data;
  let error;
  try {
    ({ data, error } = await client.auth.getUser(accessToken));
  } catch {
    return failure(503, 'AUTH_UNAVAILABLE', 'تعذر التحقق من جلسة الدخول.');
  }
  if (error || !data.user?.id) return failure(401, 'AUTH_INVALID', 'جلسة الدخول غير صالحة.');

  return { ok: true, client, user: data.user, accessToken };
}

export async function getCustomerContext(authenticated) {
  if (!authenticated?.ok) return authenticated;

  let customer;
  let error;
  const diagnosticContext = {
    userId: authenticated.user?.id ?? null,
    hasAuthorizationBearerToken: Boolean(authenticated.accessToken),
    table: 'customer_registry',
    query: 'select user_id where user_id = authenticated.user.id',
  };
  try {
    ({ data: customer, error } = await authenticated.client
      .from('customer_registry')
      .select('*')
      .eq('user_id', authenticated.user.id)
      .maybeSingle());
  } catch (exception) {
    console.error('[Customer access] customer_registry query threw an exception', {
      ...diagnosticContext,
      exception: {
        name: exception?.name ?? null,
        message: exception?.message ?? String(exception),
      },
    });
    return failure(503, 'CUSTOMER_REGISTRY_UNAVAILABLE', 'تعذر التحقق من حالة الحساب.');
  }

  if (error) {
    console.error('[Customer access] customer_registry query failed', {
      ...diagnosticContext,
      error: {
        code: error.code ?? null,
        message: error.message ?? null,
        details: error.details ?? null,
        hint: error.hint ?? null,
      },
    });
    return failure(503, 'CUSTOMER_REGISTRY_UNAVAILABLE', 'تعذر التحقق من حالة الحساب.');
  }
  if (!customer) return failure(403, 'CUSTOMER_NOT_REGISTERED', 'لا يوجد سجل عميل لهذا الحساب.');
  // is_active arrives with migration 202610150001; before it exists every customer counts as active.
  if (customer.is_active === false) return failure(403, 'CUSTOMER_SUSPENDED', 'هذا الحساب موقوف. تواصل مع الإدارة.');

  return { ...authenticated, customer };
}

/**
 * One device per account: the bound device passes, the first device binds,
 * any other device is refused (lib/device-lock.js).
 */
export async function enforceDevice(context, request) {
  if (!context?.ok) return context;
  const headerDevice = readDeviceHeader(request);
  const decision = decideDevice(context.customer?.device_id, headerDevice);
  if (decision === 'ok') return context;
  if (decision === 'missing') {
    // The app's own pages always send the id. Until every phone runs the APK whose driving
    // service sends it too, a request without one passes; DEVICE_LOCK_STRICT=true ends that.
    if (process.env.DEVICE_LOCK_STRICT !== 'true') return context;
    return failure(403, 'DEVICE_REQUIRED', DEVICE_MESSAGES.DEVICE_REQUIRED);
  }

  let result;
  try {
    const { data, error } = await context.client.rpc('bind_customer_device', { p_device: headerDevice });
    if (error) throw error;
    result = data;
  } catch (exception) {
    console.error('[Customer access] device binding failed', { message: exception?.message ?? null });
    return failure(503, 'DEVICE_CHECK_UNAVAILABLE', DEVICE_MESSAGES.UNAVAILABLE);
  }
  if (result === 'OK') return context;
  if (result === 'DEVICE_MISMATCH') return failure(403, 'DEVICE_MISMATCH', DEVICE_MESSAGES.DEVICE_MISMATCH);
  if (result === 'SUSPENDED') return failure(403, 'CUSTOMER_SUSPENDED', DEVICE_MESSAGES.SUSPENDED);
  if (result === 'NOT_REGISTERED') return failure(403, 'CUSTOMER_NOT_REGISTERED', DEVICE_MESSAGES.NOT_REGISTERED);
  return failure(403, 'DEVICE_REQUIRED', DEVICE_MESSAGES.DEVICE_REQUIRED);
}

export async function requireCustomerRegistered(request) {
  const context = await getCustomerContext(await authenticateRequest(request));
  return enforceDevice(context, request);
}

export function customerAccessResponse(access) {
  return NextResponse.json(
    { error: true, code: access.code, message: access.message },
    { status: access.status }
  );
}
