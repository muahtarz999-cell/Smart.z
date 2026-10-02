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
  try {
    ({ data: customer, error } = await authenticated.client
      .from('customer_registry')
      .select('user_id,account_status,start_date,end_date')
      .eq('user_id', authenticated.user.id)
      .maybeSingle());
  } catch {
    return failure(503, 'CUSTOMER_REGISTRY_UNAVAILABLE', 'تعذر التحقق من حالة الحساب.');
  }

  if (error) return failure(503, 'CUSTOMER_REGISTRY_UNAVAILABLE', 'تعذر التحقق من حالة الحساب.');
  if (!customer) return failure(403, 'CUSTOMER_NOT_REGISTERED', 'الحساب بانتظار التفعيل.');

  return { ...authenticated, customer };
}

export async function requireAccountActive(request) {
  const authenticated = await authenticateRequest(request);
  if (!authenticated.ok) return authenticated;

  const context = await getCustomerContext(authenticated);
  if (!context.ok) return context;

  const today = new Date().toISOString().slice(0, 10);
  if (context.customer.account_status !== 'active') {
    return failure(403, 'ACCOUNT_NOT_ACTIVE', 'الحساب غير مفعّل حاليًا.');
  }
  if (!context.customer.start_date || today < context.customer.start_date) {
    return failure(403, 'ACCOUNT_NOT_STARTED', 'لم يبدأ تفعيل الحساب بعد.');
  }

  // end_date intentionally does not affect access yet.
  return { ...context, ok: true };
}

export function customerAccessResponse(access) {
  return NextResponse.json(
    { error: true, code: access.code, message: access.message },
    { status: access.status }
  );
}
