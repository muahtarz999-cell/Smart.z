/**
 * The assistant's "brain" providers (owner request 2026-10-22). Separate from the
 * voice: speech-to-text and the spoken voice keep their own chain (cloud-tts.js,
 * transcription.js). Every provider here speaks the OpenAI chat-completions API.
 *
 *   groq       GROQ_API_KEY … GROQ_API_KEY_5        model GROQ_MODEL        (default openai/gpt-oss-120b)
 *   cerebras   CEREBRAS_API_KEY … CEREBRAS_API_KEY_3 model CEREBRAS_MODEL    (default gpt-oss-120b)
 *   omniroute  OMNIROUTE_URL + OMNIROUTE_API_KEY     model OMNIROUTE_MODEL   (default auto) — self-hosted gateway
 *   openrouter OPENROUTER_API_KEY (+ _BACKUP)        model OPENROUTER_MODEL  (default openai/gpt-oss-120b)
 *
 * BRAIN_PROVIDER_ORDER picks and orders them (default groq,cerebras,omniroute,openrouter).
 * A provider without keys is simply skipped.
 */
import { groqKeysInOrder } from './groq-keys.js';

export const BRAIN_PROVIDER_NAMES = Object.freeze(['groq', 'cerebras', 'omniroute', 'openrouter']);
export const DEFAULT_BRAIN_ORDER = 'groq,cerebras,omniroute,openrouter';

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const model = (value, fallback) => {
  const name = clean(value);
  return /^[\w./:@-]{1,120}$/.test(name) ? name : fallback;
};

/** OmniRoute base URL (https, or http on a private/local host for self-hosting) → chat endpoint, else null. */
export function omnirouteEndpoint(value) {
  const base = clean(value).replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!base) return null;
  try {
    const url = new URL(base);
    const local = /^(localhost|127\.|10\.|192\.168\.)/.test(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return `${base}/v1/chat/completions`;
  } catch {
    return null;
  }
}

/** Provider definitions read from the environment. */
export function brainProviders(env = process.env) {
  return {
    groq: {
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      model: model(env.GROQ_MODEL, 'openai/gpt-oss-120b'),
      keys: () => groqKeysInOrder(), // rotating, healthy keys first (groq-keys.js)
      fast: true,
      search: 'browser_search',
    },
    cerebras: {
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      model: model(env.CEREBRAS_MODEL, 'gpt-oss-120b'),
      keys: () => [env.CEREBRAS_API_KEY, env.CEREBRAS_API_KEY_2, env.CEREBRAS_API_KEY_3].map(clean).filter(Boolean),
      fast: true,
      search: null,
    },
    omniroute: {
      endpoint: omnirouteEndpoint(env.OMNIROUTE_URL),
      model: model(env.OMNIROUTE_MODEL, 'auto'),
      keys: () => (omnirouteEndpoint(env.OMNIROUTE_URL) ? [clean(env.OMNIROUTE_API_KEY) || 'none'] : []),
      fast: false,
      search: null,
    },
    openrouter: {
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      model: model(env.OPENROUTER_MODEL, 'openai/gpt-oss-120b'),
      keys: () => [env.OPENROUTER_API_KEY, env.OPENROUTER_API_KEY_BACKUP].map(clean).filter(Boolean),
      fast: false,
      search: 'online',
    },
  };
}

export function brainOrder(env = process.env) {
  const requested = clean(env.BRAIN_PROVIDER_ORDER || DEFAULT_BRAIN_ORDER).toLowerCase().split(/[\s,]+/);
  const order = [...new Set(requested.filter((name) => BRAIN_PROVIDER_NAMES.includes(name)))];
  return order.length ? order : DEFAULT_BRAIN_ORDER.split(',');
}

/**
 * Every key of every provider, in order: [{ provider, endpoint, key, model, timeoutMs, search }].
 * Fast providers (Groq, Cerebras) get fastTimeoutMs, gateways slowTimeoutMs.
 */
export function brainAttempts(fastTimeoutMs, slowTimeoutMs, env = process.env) {
  const providers = brainProviders(env);
  const attempts = [];
  for (const name of brainOrder(env)) {
    const provider = providers[name];
    if (!provider?.endpoint) continue;
    for (const key of provider.keys()) {
      attempts.push({
        provider: name,
        groq: name === 'groq', // kept for the Groq key health reports
        endpoint: provider.endpoint,
        key,
        model: provider.model,
        timeoutMs: provider.fast ? fastTimeoutMs : slowTimeoutMs,
        search: provider.search,
      });
    }
  }
  return attempts;
}

/** Which providers are usable now (admin «حالة النظام»): names only, never keys. */
export function brainStatus(env = process.env) {
  const providers = brainProviders(env);
  return brainOrder(env).map((name) => ({
    name,
    model: providers[name].model,
    configured: Boolean(providers[name].endpoint) && providers[name].keys().length > 0,
  }));
}
