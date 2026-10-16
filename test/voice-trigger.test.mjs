import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveVoiceTrigger } from '../lib/voice-trigger.js';

test('recognizes supported English and Arabic assistant aliases', () => {
  for (const transcript of [
    'Smart.z افتح الملاحظات',
    'SMARTZ افتح الملاحظات',
    'سمارت زاد افتح الملاحظات',
    'سمارت زد افتح الملاحظات',
    'يا سمارت افتح الملاحظات',
    'المساعد افتح الملاحظات',
  ]) {
    assert.deepEqual(resolveVoiceTrigger(transcript), {
      triggered: true,
      text: 'افتح الملاحظات',
    });
  }
});

test('normalizes Arabic diacritics, hamza variants, punctuation, and spacing', () => {
  assert.deepEqual(resolveVoiceTrigger('  يَا   سْمَارْت زِد، افتح الملاحظات  '), {
    triggered: true,
    text: 'افتح الملاحظات',
  });
});

test('recognizes common one-character speech recognition errors in a leading alias', () => {
  assert.deepEqual(resolveVoiceTrigger('سمارت زات افتح الملاحظات'), {
    triggered: true,
    text: 'افتح الملاحظات',
  });
  assert.deepEqual(resolveVoiceTrigger('المساحد افتح الملاحظات'), {
    triggered: true,
    text: 'افتح الملاحظات',
  });
});

test('asks for clarification when only the assistant alias was spoken', () => {
  assert.deepEqual(resolveVoiceTrigger('يا سمارت'), {
    triggered: true,
    text: '',
  });
});

test('recognizes and removes an alias embedded in a directed spoken request', () => {
  assert.deepEqual(resolveVoiceTrigger('من فضلك، يا سمارت افتح الملاحظات'), {
    triggered: true,
    text: 'من فضلك افتح الملاحظات',
  });
});

test('preserves ordinary speech without a leading alias for the existing assistant fallback', () => {
  assert.deepEqual(resolveVoiceTrigger('من فضلك افتح الملاحظات'), {
    triggered: false,
    text: 'من فضلك افتح الملاحظات',
  });
});
