import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { verifyComputerRequest } from './computer-device-auth.mjs';
import { createServiceClient } from './whatsapp-cluster';
import { COMPUTER_UUID_PATTERN } from './computer-task-validation.mjs';

const MAX_BODY_BYTES = 12 * 1024;

export function computerJson(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function isComputerUuid(value) {
  return typeof value === 'string' && COMPUTER_UUID_PATTERN.test(value);
}

export async function readComputerJson(request) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return { ok: false, code: 'BODY_TOO_LARGE' };
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, code: 'INVALID_JSON' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, code: 'INVALID_JSON' };
  }
}

export async function authenticateComputerRequest(request, deviceId) {
  const service = createServiceClient();
  if (!service) {
    return { response: computerJson({ error: true, code: 'COMPUTER_SERVICE_UNAVAILABLE' }, 503) };
  }

  const timestamp = request.headers.get('x-smartz-timestamp') || '';
  const nonce = request.headers.get('x-smartz-nonce') || '';
  const signature = request.headers.get('x-smartz-signature') || '';
  const bytes = new Uint8Array(await request.clone().arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) {
    return { response: computerJson({ error: true, code: 'BODY_TOO_LARGE' }, 413) };
  }

  const { data: device, error: deviceError } = await service
    .from('computer_devices')
    .select('public_key, status')
    .eq('id', deviceId)
    .maybeSingle();
  if (deviceError) {
    console.error('[Computer agent] device lookup failed', { code: deviceError.code || null });
    return { response: computerJson({ error: true, code: 'DEVICE_AUTH_FAILED' }, 503) };
  }
  if (!device || device.status !== 'active') {
    return { response: computerJson({ error: true, code: 'DEVICE_NOT_ACTIVE' }, 403) };
  }

  const url = new URL(request.url);
  const signed = verifyComputerRequest({
    publicKey: device.public_key,
    method: request.method,
    pathname: url.pathname,
    timestamp,
    nonce,
    signature,
    body: bytes,
  });
  if (!signed) {
    return { response: computerJson({ error: true, code: 'INVALID_DEVICE_SIGNATURE' }, 401) };
  }

  const { data: nonceResult, error: nonceError } = await service.rpc('consume_computer_device_nonce', {
    p_device_id: deviceId,
    p_nonce: nonce,
    p_timestamp: Number(timestamp),
  });
  if (nonceError) {
    console.error('[Computer agent] request nonce validation failed', { code: nonceError.code || null });
    return { response: computerJson({ error: true, code: 'DEVICE_AUTH_FAILED' }, 503) };
  }
  if (nonceResult?.outcome === 'device_not_active') {
    return { response: computerJson({ error: true, code: 'DEVICE_NOT_ACTIVE' }, 403) };
  }
  if (nonceResult?.outcome === 'replay') {
    return { response: computerJson({ error: true, code: 'REQUEST_REPLAYED' }, 409) };
  }
  if (nonceResult?.outcome !== 'accepted') {
    return { response: computerJson({ error: true, code: 'INVALID_DEVICE_SIGNATURE' }, 401) };
  }

  return { service, device, bodyHash: createHash('sha256').update(bytes).digest('hex') };
}
