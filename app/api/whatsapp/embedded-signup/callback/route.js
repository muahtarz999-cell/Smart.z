import { NextResponse } from 'next/server';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import {
  verifySignedSignupState,
} from '../../../../../lib/whatsapp-embedded-signup';

export const runtime = 'edge';

function getMetaGraphApiVersion() {
  const version = process.env.META_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version || '')) throw new Error('META_API_CONFIGURATION');
  return version;
}

async function metaGet(path, accessToken) {
  const url = new URL(`https://graph.facebook.com/${getMetaGraphApiVersion()}${path}`);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error('META_VALIDATION_FAILED');
  return result;
}

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);
  const user = access.user;
  const userSupabase = { client: access.client };

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const configId = process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID;
  const apiVersion = process.env.META_GRAPH_API_VERSION;
  if (!appId || !appSecret || !configId || !/^v\d+\.\d+$/.test(apiVersion || '')) {
    return NextResponse.json({ error: true, code: 'META_SETUP_INCOMPLETE', message: 'إعداد Meta غير مكتمل.' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: true, message: 'نتيجة الربط غير صالحة.' }, { status: 400 });
  }

  const { code, state, wabaId, phoneNumberId } = body || {};
  if (
    typeof code !== 'string' || !code ||
    typeof wabaId !== 'string' || !/^\d+$/.test(wabaId) ||
    typeof phoneNumberId !== 'string' || !/^\d+$/.test(phoneNumberId)
  ) {
    return NextResponse.json({ error: true, message: 'بيانات نتيجة Meta غير مكتملة.' }, { status: 400 });
  }

  try {
    const signedState = await verifySignedSignupState(state, appSecret);
    if (!signedState || signedState.userId !== user.id) {
      return NextResponse.json({ error: true, message: 'تعذر التحقق من جلسة الربط.' }, { status: 403 });
    }

    const exchangeUrl = new URL(`https://graph.facebook.com/${apiVersion}/oauth/access_token`);
    exchangeUrl.searchParams.set('client_id', appId);
    exchangeUrl.searchParams.set('client_secret', appSecret);
    exchangeUrl.searchParams.set('code', code);

    const exchangeResponse = await fetch(exchangeUrl, { method: 'GET' });
    const tokenResult = await exchangeResponse.json().catch(() => null);
    const accessToken = tokenResult?.access_token;
    if (!exchangeResponse.ok || typeof accessToken !== 'string' || !accessToken) {
      return NextResponse.json({ error: true, message: 'تعذر التحقق من نتيجة Meta.' }, { status: 502 });
    }

    const waba = await metaGet(`/${encodeURIComponent(wabaId)}?fields=id,name`, accessToken);
    if (String(waba.id) !== wabaId) throw new Error('WABA_VALIDATION_FAILED');

    const phoneNumbers = await metaGet(`/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name`, accessToken);
    const phone = phoneNumbers.data?.find((item) => String(item.id) === phoneNumberId);
    if (!phone) throw new Error('PHONE_NUMBER_VALIDATION_FAILED');

    const { data: connection, error: connectionError } = await userSupabase.client
      .from('whatsapp_connections')
      .insert({
        user_id: user.id,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        display_phone_number: phone.display_phone_number ?? null,
        verified_name: phone.verified_name ?? null,
        status: 'connected',
      })
      .select('id')
      .single();
    if (connectionError || !connection?.id) throw new Error('CONNECTION_STORAGE_FAILED');

    const { error: secretError } = await userSupabase.client
      .from('whatsapp_connection_secrets')
      .insert({
        user_id: user.id,
        connection_id: connection.id,
        access_token: accessToken,
        expires_at: tokenResult.expires_in
          ? new Date(Date.now() + Number(tokenResult.expires_in) * 1000).toISOString()
          : null,
      });
    if (secretError) {
      await userSupabase.client.from('whatsapp_connections').delete().eq('id', connection.id).eq('user_id', user.id);
      throw new Error('SECRET_STORAGE_FAILED');
    }

    return NextResponse.json({
      status: 'connected',
      connection: {
        id: connection.id,
        displayPhoneNumber: phone.display_phone_number ?? null,
        verifiedName: phone.verified_name ?? null,
      },
    });
  } catch {
    return NextResponse.json({ error: true, message: 'تعذر إكمال ربط WhatsApp. تحقق من إعدادات Meta وصلاحيات التخزين.' }, { status: 502 });
  }
}
