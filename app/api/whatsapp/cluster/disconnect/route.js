import { NextResponse } from 'next/server';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import { releaseStickyNode } from '../../../../../lib/whatsapp-cluster';

export const runtime = 'edge';

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  try {
    const released = await releaseStickyNode(access.user.id, access.client);
    return NextResponse.json(
      { success: released, message: 'تم فك حجز خادم الواتساب لحسابك بنجاح.' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('[WhatsApp Cluster Router] Failed to release node:', err);
    return NextResponse.json(
      { success: false, error: 'تعذر إلغاء تعيين خادم الواتساب.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

