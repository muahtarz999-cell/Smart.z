export async function authenticateRequest(request, authClient, registryClient) {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return { ok: false, status: 401, error: 'AUTH_REQUIRED' };

  const { data: { user }, error: authError } = await authClient.auth.getUser(bearer);
  if (authError || !user?.id) return { ok: false, status: 401, error: 'AUTH_INVALID' };

  const { data: customer, error: registryError } = await registryClient
    .from('customer_registry')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (registryError) return { ok: false, status: 503, error: 'CUSTOMER_REGISTRY_UNAVAILABLE' };
  if (!customer) return { ok: false, status: 403, error: 'CUSTOMER_NOT_REGISTERED' };

  return { ok: true, userId: user.id, customer };
}

export async function isCustomerEligible(registryClient, userId) {
  const { data: customer, error } = await registryClient
    .from('customer_registry')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  return !error && Boolean(customer);
}
