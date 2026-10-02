export async function authenticateRequest(request, authClient, registryClient) {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return { ok: false, status: 401, error: 'AUTH_REQUIRED' };

  const { data: { user }, error: authError } = await authClient.auth.getUser(bearer);
  if (authError || !user?.id) return { ok: false, status: 401, error: 'AUTH_INVALID' };

  const { data: customer, error: registryError } = await registryClient
    .from('customer_registry')
    .select('user_id,account_status,start_date')
    .eq('user_id', user.id)
    .maybeSingle();
  if (registryError) return { ok: false, status: 503, error: 'CUSTOMER_REGISTRY_UNAVAILABLE' };
  if (!customer) return { ok: false, status: 403, error: 'CUSTOMER_NOT_REGISTERED' };
  if (customer.account_status !== 'active') return { ok: false, status: 403, error: 'ACCOUNT_NOT_ACTIVE' };

  const today = new Date().toISOString().slice(0, 10);
  if (!customer.start_date || today < customer.start_date) {
    return { ok: false, status: 403, error: 'ACCOUNT_NOT_STARTED' };
  }

  // end_date intentionally does not affect access yet.
  return { ok: true, userId: user.id, customer };
}

export async function isCustomerEligible(registryClient, userId) {
  const { data: customer, error } = await registryClient
    .from('customer_registry')
    .select('account_status,start_date')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !customer || customer.account_status !== 'active') return false;
  const today = new Date().toISOString().slice(0, 10);
  return Boolean(customer.start_date && today >= customer.start_date);
}
