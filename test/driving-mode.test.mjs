import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCancelCommand, isDrivingStartCommand, isDrivingStopCommand, isLikelyHallucination,
} from '../lib/driving-commands.js';
import { createSpeechDetector } from '../lib/speech-detector.js';

test('driving mode: start and stop phrases', () => {
  for (const phrase of ['وضع القيادة', 'شغّل وضع القيادة', 'فعل وضع القياده', 'وضع القيادة يا سمارت', 'وضع القيادة.']) {
    assert.equal(isDrivingStartCommand(phrase), true, phrase);
    assert.equal(isDrivingStopCommand(phrase), false, phrase);
  }
  for (const phrase of ['وضع القيادة انتهى', 'أنهِ وضع القيادة', 'اوقف وضع القيادة', 'انتهى وضع القيادة', 'وصلت', 'وصلت الحمد لله', 'خلاص وضع القيادة']) {
    assert.equal(isDrivingStopCommand(phrase), true, phrase);
    assert.equal(isDrivingStartCommand(phrase), false, phrase);
  }
  for (const phrase of ['اشرح لي وضع القيادة', 'كيف يعمل وضع القيادة', 'وصلت رسالة من أحمد؟', 'هل وضع القيادة شغال', 'ابي اعرف وضع القيادة', 'أرسل لأحمد إني في وضع القيادة الحين وما أقدر أرد']) {
    assert.equal(isDrivingStartCommand(phrase), false, phrase);
    assert.equal(isDrivingStopCommand(phrase), false, phrase);
  }
});

test('driving mode: Whisper silence hallucinations and noise are ignored, real speech is not', () => {
  for (const noise of ['', ' . ', 'اشتركوا في القناة', 'شكراً للمشاهدة!', 'ترجمة نانسي قنقر', 'موسيقى', '[موسيقى]']) {
    assert.equal(isLikelyHallucination(noise), true, JSON.stringify(noise));
  }
  for (const speech of ['كم الساعة', 'أرسل لأمي إني وصلت', 'شكراً', 'لا']) {
    assert.equal(isLikelyHallucination(speech), false, speech);
  }
  assert.equal(isCancelCommand('تراجع'), true);
  assert.equal(isCancelCommand('لا ترسل'), true);
  assert.equal(isCancelCommand('أرسل'), false);
});

function run(detector, frames) {
  const events = [];
  frames.forEach((rms, index) => {
    const event = detector.push(rms);
    if (event) events.push([event, index]);
  });
  return events;
}

const repeat = (value, count) => Array(count).fill(value);

test('speech detector: a sentence in a quiet car starts after 200 ms and ends after 900 ms of silence', () => {
  const detector = createSpeechDetector();
  const events = run(detector, [...repeat(0.005, 20), ...repeat(0.12, 15), ...repeat(0.004, 12)]);
  assert.deepEqual(events, [['start', 21], ['end', 43]]);
  // Speaking right away still works once the room was measured.
  assert.deepEqual(run(createSpeechDetector(), [...repeat(0.006, 3), ...repeat(0.15, 8), ...repeat(0.006, 9)]).map(([e]) => e), ['start', 'end']);
});

test('speech detector: road noise raises the bar; a bump is discarded, not sent', () => {
  const detector = createSpeechDetector();
  // Steady road noise at 0.03 never triggers.
  assert.deepEqual(run(detector, repeat(0.03, 100)), []);
  // The bar follows the noise, with a smaller margin in a loud car (2x, not 3x).
  assert.ok(detector.threshold > 0.05 && detector.threshold < 0.08, `threshold follows the noise (${detector.threshold})`);
  // A short bump (300 ms) above the bar → discard.
  assert.deepEqual(run(detector, [...repeat(0.2, 3), ...repeat(0.03, 10)]).map(([e]) => e), ['start', 'discard']);
  // A real sentence over the noise → end.
  assert.deepEqual(run(detector, [...repeat(0.25, 20), ...repeat(0.03, 10)]).map(([e]) => e), ['start', 'end']);
});

test('speech detector: a normal voice is heard over road noise, and does not raise the bar itself', () => {
  // Before: road noise 0.03 put the bar at 0.09, and the voice frames under it
  // dragged the floor up until the bar reached 0.14; nothing was ever heard.
  const detector = createSpeechDetector();
  const events = run(detector, [...repeat(0.03, 40), ...repeat(0.08, 20), ...repeat(0.03, 12)]).map(([e]) => e);
  assert.deepEqual(events, ['start', 'end']);
  // Soft speech that stays under the bar must not move it up much either.
  const soft = createSpeechDetector();
  run(soft, repeat(0.03, 40));
  const before = soft.threshold;
  run(soft, repeat(0.055, 30));
  assert.ok(soft.threshold - before < 0.01, `bar stayed put (${before} → ${soft.threshold})`);
  // A quieter room brings the bar back down quickly.
  run(soft, repeat(0.006, 15));
  assert.ok(soft.threshold < 0.03, `bar falls with the room (${soft.threshold})`);
});

test('speech detector: short pauses inside a sentence do not cut it; the 30 s limit does', () => {
  const detector = createSpeechDetector();
  const sentence = [...repeat(0.1, 10), ...repeat(0.004, 6), ...repeat(0.1, 10), ...repeat(0.004, 10)];
  assert.deepEqual(run(detector, [...repeat(0.004, 5), ...sentence]).map(([e]) => e), ['start', 'end']);
  assert.deepEqual(run(createSpeechDetector(), [...repeat(0.004, 3), ...repeat(0.1, 400)]).map(([e]) => e), ['start', 'max', 'start']);
});

// ---------------------------------------------------------------- one turn of the Android service
const { runDriveTurn, sendDelivery, textForSpeech } = await import('../lib/drive-turn.js');

function driveDeps({ transcript = 'كم الساعة', turn = { reply: 'الساعة الثالثة.', toolCalls: [] }, plan = null, ttsFails = false } = {}) {
  const calls = { assistant: [], tts: [] };
  return {
    calls,
    deps: {
      transcribe: async () => transcript,
      assistantTurn: async (text, options) => { calls.assistant.push({ text, options }); return turn; },
      sendTool: { name: 'send_whatsapp_message' },
      planSend: plan ? async () => plan : null,
      synthesize: async (text) => {
        calls.tts.push(text);
        if (ttsFails) throw new Error('no voice');
        return { audio: new Uint8Array([1, 2, 3]), contentType: 'audio/wav' };
      },
    },
  };
}

test('drive turn: a question is answered on the driving channel and comes back as audio', async () => {
  const { deps, calls } = driveDeps();
  const result = await runDriveTurn({ audio: {}, context: { history: [{ role: 'user', content: 'هلا' }], voice: { provider: 'groq' } } }, deps);
  assert.equal(result.kind, 'reply');
  assert.equal(result.reply, 'الساعة الثالثة.');
  assert.deepEqual(result.audio, [{ mime: 'audio/wav', data: 'AQID' }]);
  assert.equal(calls.assistant[0].options.channel, 'driving');
  assert.deepEqual(calls.assistant[0].options.tools, [], 'no send tool without a linked WhatsApp');
});

test('drive turn: noise is ignored without asking anyone; stop and cancel are handled before the assistant', async () => {
  let { deps, calls } = driveDeps({ transcript: 'شكراً للمشاهدة' });
  assert.equal((await runDriveTurn({ audio: {} }, deps)).kind, 'ignored');
  assert.equal(calls.assistant.length + calls.tts.length, 0);

  ({ deps, calls } = driveDeps({ transcript: 'وضع القيادة انتهى' }));
  const stop = await runDriveTurn({ audio: {} }, deps);
  assert.equal(stop.kind, 'stop');
  assert.equal(calls.assistant.length, 0);

  ({ deps, calls } = driveDeps({ transcript: 'تراجع' }));
  assert.equal((await runDriveTurn({ audio: {}, context: { pendingSend: true } }, deps)).kind, 'cancel_send');
  ({ deps } = driveDeps({ transcript: 'تراجع' }));
  assert.equal((await runDriveTurn({ audio: {}, context: { pendingSend: false } }, deps)).kind, 'reply', 'nothing to cancel → normal turn');
});

test('drive turn: one person is sent by the service; more than 5, a document or "confirm every send" wait in the app', async () => {
  const send = { reply: '', toolCalls: [{ name: 'send_whatsapp_message', args: { recipients: ['أحمد'], message: 'بتأخر' } }] };
  const action = { type: 'whatsapp_send', recipients: [{ jid: '1@s', name: 'أحمد' }], text: 'بتأخر', requiresManualConfirmation: false };
  const { deps } = driveDeps({ turn: send, plan: { reply: 'تم، أرسلت إلى أحمد.', action } });
  const one = await runDriveTurn({ audio: {} }, deps);
  assert.equal(one.actionDelivery, 'service');
  assert.equal(one.reply, 'تم، أرسلت إلى أحمد.');

  assert.equal(sendDelivery({ ...action, requiresManualConfirmation: true }).delivery, 'app');
  assert.match(sendDelivery({ ...action, requiresManualConfirmation: true }).reply, /أكثر من خمسة/);
  assert.equal(sendDelivery({ ...action, attachDocument: 'عقد' }).delivery, 'app');
  assert.equal(sendDelivery(action, { confirmEverySend: true }).delivery, 'app');
});

test('drive turn: when every cloud voice fails the reply still arrives (the phone speaks it)', async () => {
  const { deps } = driveDeps({ ttsFails: true });
  const result = await runDriveTurn({ audio: {} }, deps);
  assert.equal(result.reply, 'الساعة الثالثة.');
  assert.deepEqual(result.audio, []);
  assert.equal(textForSpeech('**مهم**: راجع https://x.y\n- أولاً'), 'مهم: راجع أولاً');
});

test('drive turn: reply chunks are voiced at most two at a time, in order', async () => {
  const { speakChunks, SPEECH_CONCURRENCY } = await import('../lib/drive-turn.js');
  let active = 0;
  let peak = 0;
  const synthesize = async (chunk) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { audio: new TextEncoder().encode(chunk), contentType: 'audio/wav' };
  };
  const reply = Array.from({ length: 6 }, (_, i) => `هذه الجملة رقم ${i + 1} في الرد وهي طويلة بما يكفي لتكون مقطعًا مستقلًا عن غيرها تمامًا.`).join(' ');
  const audio = await speakChunks(reply, {}, synthesize);
  assert.ok(audio.length >= 3, `several chunks (${audio.length})`);
  assert.ok(peak <= SPEECH_CONCURRENCY, `never more than ${SPEECH_CONCURRENCY} at once (peak ${peak})`);
  const decoded = audio.map((a) => new TextDecoder().decode(Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0))));
  assert.match(decoded[0], /رقم 1/);
  assert.match(decoded.at(-1), /رقم 6/);
});
