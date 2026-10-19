import { NextResponse } from 'next/server';
import { requireCustomerRegistered } from './customer-access';
import { createServiceClient } from './whatsapp-cluster';
import {
  computerAccessFailure,
  isComputerUuid,
  readComputerJson,
  validateComputerTask,
} from './computer-task-validation.mjs';

export { isComputerUuid, readComputerJson, validateComputerTask };

export function computerJson(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function callComputerRpc(service, procedure, parameters) {
  try {
    const result = await service.rpc(procedure, parameters);
    if (result.error) {
      console.error('[Computer pairing] database operation failed', {
        procedure,
        code: result.error.code || null,
      });
    }
    return result;
  } catch (error) {
    console.error('[Computer pairing] database operation threw', {
      procedure,
      code: error?.code || null,
    });
    return { data: null, error: { code: error?.code || null } };
  }
}

export async function requireComputerAccess(request) {
  const access = await requireCustomerRegistered(request);
  const failure = computerAccessFailure(access);

  if (failure) {
    const { status, ...body } = failure;
    return { response: computerJson(body, status) };
  }

  const service = createServiceClient();

  if (!service) {
    return {
      response: computerJson({
        error: true,
        code: 'COMPUTER_SERVICE_UNAVAILABLE',
        message: 'خدمة ربط الكمبيوتر غير متاحة حاليًا.',
      }, 503),
    };
  }

  return { access, service };
}
