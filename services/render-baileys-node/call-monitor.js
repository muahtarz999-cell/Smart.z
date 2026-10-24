/**
 * Follows one AI-receptionist call (owner request 2026-10-22).
 *
 * The app accepted the call with OpenAI (app/api/voice/openai/webhook) and asks
 * this node to follow it: a WebSocket to the live call says the greeting, runs
 * the tools (take_message, transfer_to_owner, end_call), keeps the text of the
 * conversation in memory, and when the call ends reports it to the app for the
 * summary. Nothing is written to disk; the audio never passes through here.
 */
import WebSocket from 'ws';

const OPENAI_CALLS = 'https://api.openai.com/v1/realtime/calls';
const MAX_CALL_MS = 10 * 60 * 1000;
const MAX_LINES = 80;

export class CallMonitor {
  constructor({ apiKey, report, logger }) {
    this.apiKey = apiKey;
    this.report = report; // async (payload) => void
    this.logger = logger;
    this.active = new Map(); // callId → session
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  /** { callId, userId, channel, callerNumber, transferNumber } */
  follow(call) {
    if (!this.enabled || this.active.has(call.callId) || this.active.size >= 20) return false;
    const session = {
      ...call,
      startedAt: new Date().toISOString(),
      transcript: [],
      messages: [],
      transferred: false,
      finished: false,
    };
    this.active.set(call.callId, session);

    const socket = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(call.callId)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    session.socket = socket;
    session.timer = setTimeout(() => void this.hangup(session), MAX_CALL_MS);

    socket.on('open', () => this.send(session, { type: 'response.create' })); // the receptionist speaks first
    socket.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return; }
      void this.onEvent(session, event).catch((error) => this.logger.error({ err: error }, 'call event failed'));
    });
    socket.on('error', (error) => this.logger.warn({ err: error }, 'call socket error'));
    socket.on('close', () => void this.finish(session));
    return true;
  }

  send(session, event) {
    if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(event));
  }

  line(session, role, text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    session.transcript.push({ role, text: clean.slice(0, 400) });
    if (session.transcript.length > MAX_LINES) session.transcript.shift();
  }

  async onEvent(session, event) {
    switch (event.type) {
      case 'conversation.item.input_audio_transcription.completed':
        this.line(session, 'caller', event.transcript);
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        this.line(session, 'assistant', event.transcript);
        break;
      case 'response.function_call_arguments.done':
        await this.onTool(session, event);
        break;
      case 'error':
        this.logger.warn({ code: event.error?.code || null }, 'realtime error');
        break;
      default:
    }
  }

  async onTool(session, event) {
    let args = {};
    try { args = JSON.parse(event.arguments || '{}'); } catch { args = {}; }
    let output = { ok: true };
    let thenHangUp = false;

    if (event.name === 'take_message') {
      if (session.messages.length < 5) session.messages.push(args);
      output = { ok: true, note: 'سُجّلت الرسالة وستصل لصاحب الرقم.' };
    } else if (event.name === 'transfer_to_owner') {
      const digits = String(session.transferNumber || '').replace(/\D/g, '');
      if (digits && !session.transferred) {
        const ok = await this.callApi(session, 'refer', { target_uri: `tel:+${digits}` });
        session.transferred = ok;
        output = ok ? { ok: true } : { ok: false, reason: 'تعذر التحويل؛ خذ رسالته بدلًا من ذلك.' };
      } else {
        output = { ok: false, reason: 'التحويل غير متاح؛ خذ رسالته.' };
      }
    } else if (event.name === 'end_call') {
      thenHangUp = true;
    }

    this.send(session, {
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(output) },
    });
    if (thenHangUp) {
      setTimeout(() => void this.hangup(session), 2_500); // let the goodbye finish
    } else {
      this.send(session, { type: 'response.create' });
    }
  }

  async callApi(session, action, body) {
    try {
      const response = await fetch(`${OPENAI_CALLS}/${encodeURIComponent(session.callId)}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async hangup(session) {
    if (session.finished) return;
    await this.callApi(session, 'hangup');
    try { session.socket?.close(); } catch { /* already closed */ }
  }

  async finish(session) {
    if (session.finished) return;
    session.finished = true;
    clearTimeout(session.timer);
    this.active.delete(session.callId);
    try {
      await this.report({
        callId: session.callId,
        userId: session.userId,
        channel: session.channel,
        callerNumber: session.callerNumber,
        startedAt: session.startedAt,
        endedAt: new Date().toISOString(),
        transcript: session.transcript,
        messages: session.messages,
        transferred: session.transferred,
      });
    } catch (error) {
      this.logger.error({ err: error }, 'call report failed');
    }
  }
}
