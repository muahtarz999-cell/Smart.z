import { NextResponse } from 'next/server';
import { confirmationCode, parseSignedRequest } from '../../../../lib/meta-signed-request';

export const runtime = 'edge';

/**
 * Meta's Data Deletion Request Callback. Called when a person removes the app
 * in their Facebook settings and asks for their data to be deleted.
 *
 * Smart.z keeps no Facebook profile data and no Facebook user IDs: Embedded
 * Signup only yields WhatsApp Business account identifiers and a token, tied
 * to a Smart.z account (deleted by disconnecting WhatsApp or deleting the
 * account). So there is nothing keyed by this user_id to delete; the request
 * is acknowledged with the status page and code Meta requires.
 */
export async function POST(request) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 });

  const form = await request.formData().catch(() => null);
  const payload = await parseSignedRequest(form?.get('signed_request'), appSecret);
  if (!payload) return NextResponse.json({ error: 'INVALID_SIGNED_REQUEST' }, { status: 400 });

  const code = await confirmationCode(payload.user_id, payload.issued_at || 0, appSecret);
  const url = new URL(`/data-deletion?code=${code}`, request.url).toString();
  // No user id or personal data is logged; the code alone identifies the request.
  console.log('[Meta data deletion] request acknowledged', { code });
  return NextResponse.json({ url, confirmation_code: code });
}
