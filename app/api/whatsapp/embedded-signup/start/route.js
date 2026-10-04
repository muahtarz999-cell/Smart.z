import { NextResponse } from 'next/server';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import { createSignedSignupState } from '../../../../../lib/whatsapp-embedded-signup';

export const runtime = 'edge';

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const configId = process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID;
  if (!appId || !appSecret || !configId) {
    return NextResponse.json({ error: true, code: 'META_SETUP_INCOMPLETE', message: 'إعداد Meta غير مكتمل.' }, { status: 503 });
  }

  try {
    const state = await createSignedSignupState(access.user.id, appSecret);
    return NextResponse.json({ appId, configId, state });
  } catch {
    return NextResponse.json({ error: true, message: 'تعذر بدء الربط الرسمي حاليًا.' }, { status: 500 });
  }
}
