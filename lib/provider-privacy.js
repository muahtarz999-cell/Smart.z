/**
 * Privacy settings sent with every request to an AI provider.
 *
 * OpenRouter forwards a request to one of many upstream providers; by default
 * some of them may keep or train on prompts. `data_collection: 'deny'` limits
 * routing to providers that do not, which WhatsApp's Business Solution Terms
 * require for message content (no third-party model training).
 */
const OPENROUTER_HOST = 'openrouter.ai';

export const OPENROUTER_PRIVACY = Object.freeze({ provider: Object.freeze({ data_collection: 'deny' }) });

/** Returns the request body with the provider's privacy settings added when the endpoint needs them. */
export function withProviderPrivacy(endpoint, body) {
  if (typeof endpoint === 'string' && endpoint.includes(OPENROUTER_HOST)) {
    return { ...body, provider: { ...(body?.provider || {}), ...OPENROUTER_PRIVACY.provider } };
  }
  return body;
}
