import { NextResponse } from 'next/server';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../../lib/customer-access';
import { getUserAssignedNode, proxyToNode } from '../../../../../lib/whatsapp-cluster';

export const runtime = 'edge';

export async function GET(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  // 1. Check if user has an assigned node
  let assignedNode;
  try {
    assignedNode = await getUserAssignedNode(access.user.id, access.client);
  } catch (err) {
    console.error('[WhatsApp Cluster Router] Status lookup failed:', err);
    return NextResponse.json(
      { status: 'ERROR', error: 'تعذر التحقق من حالة خادم الواتساب.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (!assignedNode) {
    return NextResponse.json(
      {
        status: 'DISCONNECTED',
        connected: false,
        assigned: false,
        message: 'لا يوجد خادم واتساب مخصص لحسابك بعد.',
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 2. Query node live status
  try {
    const proxyResult = await proxyToNode(assignedNode, '/api/status');
    const nodeData = typeof proxyResult.data === 'object' && proxyResult.data !== null
      ? proxyResult.data
      : { status: 'UNKNOWN' };

    return NextResponse.json(
      {
        ...nodeData,
        nodeId: assignedNode.id,
        assigned: true,
        connected: nodeData.status === 'CONNECTED',
      },
      {
        status: proxyResult.status,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (proxyError) {
    return NextResponse.json(
      {
        status: 'UNREACHABLE',
        connected: false,
        nodeId: assignedNode.id,
        assigned: true,
        error: `الخادم المخصص رقم ${assignedNode.id} لا يستجيب حالياً.`,
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

