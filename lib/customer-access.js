import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

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
      .select('user_id')
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

  return { ...authenticated, customer };
}

export async function requireCustomerRegistered(request) {
  const authenticated = await authenticateRequest(request);
  if (!authenticated.ok) return authenticated;

  return getCustomerContext(authenticated);
}

export function customerAccessResponse(access) {
  return NextResponse.json(
    { error: true, code: access.code, message: access.message },
    { status: access.status }
  );
}
