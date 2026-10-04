import { NextResponse } from 'next/server';
import { customerAccessResponse, requireCustomerRegistered } from '../../../../lib/customer-access';

export const runtime = 'edge';

export async function GET(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  return NextResponse.json({
    active: true,
    user: { id: access.user.id, email: access.user.email ?? null },
    customer: { user_id: access.customer.user_id },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
