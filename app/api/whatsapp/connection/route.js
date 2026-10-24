import { NextResponse } from 'next/server';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../lib/customer-access';
import { setWhatsAppReceptionist } from '../../../../lib/receptionist-store';
import { createServiceClient } from '../../../../lib/whatsapp-cluster';
import { businessConnection, setMetaCalling } from '../../../../lib/whatsapp-calling';


export async function GET(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  let connection;
  let error;
  try {
    ({ data: connection, error } = await access.client
      .from('whatsapp_connections')
      .select('id,display_phone_number,verified_name,status')
      .eq('user_id', access.user.id)
      .eq('status', 'connected')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle());
  } catch {
    return NextResponse.json(
      { error: true, message: 'تعذر جلب حالة ربط WhatsApp.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  if (error) {
    console.error('[WhatsApp connection] Lookup failed', {
      code: error.code ?? null,
    });
    return NextResponse.json(
      { error: true, message: 'تعذر جلب حالة ربط WhatsApp.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json(
    {
      connection: connection
        ? {
            id: connection.id,
            displayPhoneNumber: connection.display_phone_number,
            verifiedName: connection.verified_name,
          }
        : null,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

// Disconnects the official WhatsApp Business link: removes the connection and,
// through the foreign key's ON DELETE CASCADE, its stored Meta access token.
export async function DELETE(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  // AI answering of WhatsApp calls ends with the business link (lib/whatsapp-calling.js).
  const service = createServiceClient();
  if (service) {
    try {
      const connection = await businessConnection(service, access.user.id);
      if (connection) await setMetaCalling(connection, false).catch(() => null);
      await setWhatsAppReceptionist(service, access.user.id, false, null);
    } catch {
      // The receptionist tables may not exist yet; the disconnect still goes ahead.
    }
  }

  const { error } = await access.client
    .from('whatsapp_connections')
    .delete()
    .eq('user_id', access.user.id);
  if (error) {
    console.error('[WhatsApp connection] Delete failed', { code: error.code ?? null });
    return NextResponse.json(
      { error: true, message: 'تعذر فصل ربط WhatsApp.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
}
