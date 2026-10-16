import assert from 'node:assert/strict';
import test from 'node:test';
import { ContactBook, normalizeName } from '../services/render-baileys-node/contacts.js';

test('contact search: Arabic spelling variants, ambiguity, groups and local numbers', () => {
  const book = new ContactBook({ supabase: null, nodeId: 1, dir: '/tmp' });
  book.save = async () => {};
  book.upsert([
    { id: '966500000001@s.whatsapp.net', name: 'أحمد الشغل' },
    { id: '966500000002@s.whatsapp.net', name: 'احمد أخوي' },
    { id: '966500000003@s.whatsapp.net', notify: 'خالد' },
    { id: '966500000004@s.whatsapp.net', name: 'أُمّي' },
  ]);
  book.addGroups([{ id: '1203@g.us', subject: 'العائلة' }]);
  assert.equal(normalizeName('أُمّي'), 'امي');
  assert.equal(book.search('أحمد').length, 2);
  assert.deepEqual(book.search('احمد الشغل').map((m) => m.jid), ['966500000001@s.whatsapp.net']);
  assert.equal(book.search('امي')[0].jid, '966500000004@s.whatsapp.net');
  assert.equal(book.search('العائلة').length, 0);
  assert.equal(book.search('العائلة', { groups: true })[0].jid, '1203@g.us');
  assert.equal(book.search('0500 000 009', { ownNumber: '966511111111' })[0].jid, '966500000009@s.whatsapp.net');
});
