import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { confirmationCode, parseSignedRequest } from '../lib/meta-signed-request.js';
import { withProviderPrivacy } from '../lib/provider-privacy.js';

const SECRET = 'test-app-secret';
const b64url = (buffer) => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Builds a signed_request exactly as Meta does: base64url(HMAC-SHA256(payload)) + '.' + base64url(payload JSON).
function signedRequest(payload, secret = SECRET) {
  const encodedPayload = b64url(JSON.stringify(payload));
  const signature = b64url(createHmac('sha256', secret).update(encodedPayload).digest());
  return `${signature}.${encodedPayload}`;
}

const valid = { algorithm: 'HMAC-SHA256', user_id: '1234567890', issued_at: 1792252000, expires: 0 };

test('a genuine Meta signed_request is accepted and decoded', async () => {
  const payload = await parseSignedRequest(signedRequest(valid), SECRET);
  assert.equal(payload.user_id, '1234567890');
});

test('forged, tampered or malformed requests are rejected', async () => {
  assert.equal(await parseSignedRequest(signedRequest(valid, 'other-secret'), SECRET), null, 'wrong secret');
  const [signature] = signedRequest(valid).split('.');
  const tampered = `${signature}.${b64url(JSON.stringify({ ...valid, user_id: '999' }))}`;
  assert.equal(await parseSignedRequest(tampered, SECRET), null, 'payload changed after signing');
  assert.equal(await parseSignedRequest(signedRequest({ ...valid, algorithm: 'none' }), SECRET), null, 'wrong algorithm');
  assert.equal(await parseSignedRequest(signedRequest({ algorithm: 'HMAC-SHA256' }), SECRET), null, 'no user');
  for (const bad of ['', 'abc', '.abc', 'abc.', undefined, null, 42]) {
    assert.equal(await parseSignedRequest(bad, SECRET), null, `malformed ${String(bad)}`);
  }
  assert.equal(await parseSignedRequest(signedRequest(valid), ''), null, 'no secret configured');
});

test('the confirmation code is stable, short and different per request', async () => {
  const first = await confirmationCode('1234567890', 1792252000, SECRET);
  assert.match(first, /^[a-f0-9]{16}$/, 'matches the status page pattern');
  assert.equal(await confirmationCode('1234567890', 1792252000, SECRET), first);
  assert.notEqual(await confirmationCode('1234567890', 1792252001, SECRET), first);
});

test('OpenRouter requests deny data collection; other providers are left untouched', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const routed = withProviderPrivacy('https://openrouter.ai/api/v1/chat/completions', body);
  assert.deepEqual(routed.provider, { data_collection: 'deny' });
  assert.deepEqual(routed.messages, body.messages);
  assert.equal(body.provider, undefined, 'the original body is not mutated');
  const kept = withProviderPrivacy('https://openrouter.ai/api/v1/chat/completions', { ...body, provider: { order: ['x'] } });
  assert.deepEqual(kept.provider, { order: ['x'], data_collection: 'deny' }, 'existing routing preferences are kept');
  assert.equal(withProviderPrivacy('https://api.groq.com/openai/v1/chat/completions', body), body);
});
