import { NextResponse } from 'next/server';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import { allocateStickyNode, proxyToNode } from '../../../../../lib/whatsapp-cluster';

export const runtime = 'edge';

export async function GET(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const { searchParams } = new URL(request.url);
  const method = searchParams.get('method') || 'qr';
  const phoneNumber = searchParams.get('phoneNumber') || '';

  if (method === 'pairing_code' && !phoneNumber) {
    return NextResponse.json(
      { success: false, error: 'يلزم توفير رقم الهاتف لطلب رمز الاقتران.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 1. Allocate or retrieve assigned sticky node for this tenant
  let targetNode;
  try {
    const allocation = await allocateStickyNode(access.user.id, access.client);
    targetNode = allocation.node;
  } catch (err) {
    console.error('[WhatsApp Cluster Router] Node allocation failed:', err);
    if (err?.code === 'ALL_CLUSTER_NODES_OCCUPIED') {
      return NextResponse.json(
        {
          success: false,
          error: 'جميع قنوات خوادم الواتساب (5/5) مشغولة حالياً بمشتركين آخرين. يرجى التواصل مع الإدارة لزيادة السعة.',
          code: 'ALL_NODES_OCCUPIED',
        },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: 'تعذر تحديد خادم الواتساب المخصص لحسابك.',
        details: err?.message,
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 2. Forward connect request to the tenant's dedicated node
  try {
    const proxyResult = await proxyToNode(targetNode, '/api/connect', {
      method,
      phoneNumber,
    });

    const responseBody = typeof proxyResult.data === 'object' && proxyResult.data !== null
      ? { ...proxyResult.data, nodeId: targetNode.id }
      : { success: proxyResult.ok, data: proxyResult.data, nodeId: targetNode.id };

    return NextResponse.json(responseBody, {
      status: proxyResult.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (proxyError) {
    console.error(`[WhatsApp Cluster Router] Proxy error to Node ${targetNode.id}:`, proxyError);
    return NextResponse.json(
      {
        success: false,
        error: `تعذر الاتصال بخادم الواتساب المخصص (خادم رقم ${targetNode.id}).`,
        details: proxyError?.message,
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

