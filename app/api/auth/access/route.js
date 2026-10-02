import { NextResponse } from 'next/server';
import { customerAccessResponse, requireAccountActive } from '../../../../lib/customer-access';

export const runtime = 'edge';

export async function GET(request) {
  const access = await requireAccountActive(request);
  if (!access.ok) return customerAccessResponse(access);

  return NextResponse.json({
    active: true,
    user: { id: access.user.id, email: access.user.email ?? null },
    customer: {
      account_status: access.customer.account_status,
      start_date: access.customer.start_date,
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
