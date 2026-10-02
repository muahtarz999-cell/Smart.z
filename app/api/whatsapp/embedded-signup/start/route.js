import { NextResponse } from 'next/server';
import { createSignedSignupState, createUserSupabase } from '../../../../../lib/whatsapp-embedded-signup';

export const runtime = 'edge';

export async function POST(request) {
  const userSupabase = createUserSupabase(request);
  if (!userSupabase) {
    return NextResponse.json({ error: true, message: 'سجّل الدخول إلى Smart.z أولًا.' }, { status: 401 });
  }

  const { data: { user }, error } = await userSupabase.client.auth.getUser(userSupabase.accessToken);
  if (error || !user) {
    return NextResponse.json({ error: true, message: 'انتهت جلسة الدخول. سجّل الدخول مجددًا.' }, { status: 401 });
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const configId = process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID;
  if (!appId || !appSecret || !configId) {
    return NextResponse.json({ error: true, code: 'META_SETUP_INCOMPLETE', message: 'إعداد Meta غير مكتمل.' }, { status: 503 });
  }

  try {
    const state = await createSignedSignupState(user.id, appSecret);
    return NextResponse.json({ appId, configId, state });
  } catch {
    return NextResponse.json({ error: true, message: 'تعذر بدء الربط الرسمي حاليًا.' }, { status: 500 });
  }
}
