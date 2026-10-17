import assert from 'node:assert/strict';
import test from 'node:test';
import { SentCache } from '../sent-cache.js';

// Shape returned by Baileys sock.sendMessage.
const sent = (id, message) => ({ key: { id, remoteJid: '966500000000@s.whatsapp.net', fromMe: true }, message });
const voice = { audioMessage: { url: 'https://mmg.whatsapp.net/x', mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 4 } };
const text = { conversation: 'هلا' };

test('a retry request finds the voice note and the text that were sent', () => {
  const cache = new SentCache();
  cache.remember(sent('V1', voice), 'voice');
  cache.remember(sent('T1', text), 'text');
  assert.deepEqual(cache.get('V1').message, voice, 'getMessage must return the same proto so Baileys can re-encrypt it');
  assert.equal(cache.kindOf('V1'), 'voice');
  assert.deepEqual(cache.get('T1').message, text, 'text sends keep working through the same path');
  assert.equal(cache.get('UNKNOWN'), undefined);
});

test('old entries expire and the cache stays bounded', () => {
  let now = 0;
  const cache = new SentCache({ limit: 2, ttlMs: 1000, now: () => now });
  cache.remember(sent('A', text));
  cache.remember(sent('B', text));
  cache.remember(sent('C', text));
  assert.equal(cache.get('A'), undefined, 'oldest dropped past the limit');
  assert.ok(cache.get('C'));
  now = 1001;
  assert.equal(cache.get('C'), undefined, 'expired');
});

test('nothing is stored without an id or a message', () => {
  const cache = new SentCache();
  cache.remember(undefined);
  cache.remember({ key: {} , message: text });
  cache.remember({ key: { id: 'X' } });
  assert.equal(cache.items.size, 0);
});
