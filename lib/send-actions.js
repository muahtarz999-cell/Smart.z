'use client';

/**
 * Executes WhatsApp sends the user commanded by voice or text.
 *   - Clear command: sent after an undo window (default 5 s, 0 = immediately).
 *   - More than 5 people, or "confirm every send" turned on: waits for a tap.
 *   - Saying or typing "تراجع" during the window cancels it.
 */

const SETTINGS_KEY = 'smartz-actions-v1';
const DEFAULTS = Object.freeze({ undoSeconds: 5, confirmEverySend: false });
const CANCEL_PATTERN = /^\s*(تراجع|تراجعي|الغ|ألغ|الغي|ألغي|إلغاء|الغاء|لا ترسل|لا تبعث|وقف|كنسل|cancel|stop)/i;

let getAccessToken = async () => null;
let onResult = () => {};
let state = null; // { action, status: counting|confirm|sending|sent|failed|cancelled, secondsLeft?, error? }
let timer = null;
let clearTimer = null;
const listeners = new Set();

export function getActionSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const undo = Number(stored.undoSeconds);
    return {
      undoSeconds: Number.isFinite(undo) && undo >= 0 && undo <= 30 ? undo : DEFAULTS.undoSeconds,
      confirmEverySend: stored.confirmEverySend === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveActionSettings(changes) {
  const next = { ...getActionSettings(), ...changes };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
  return next;
}

export function configureSendActions(options = {}) {
  if (typeof options.getAccessToken === 'function') getAccessToken = options.getAccessToken;
  if (typeof options.onResult === 'function') onResult = options.onResult;
}

export function subscribe(listener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export function getPendingSend() {
  return state;
}

function setState(next) {
  state = next;
  for (const listener of listeners) listener(state);
}

function clearLater(ms) {
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => setState(null), ms);
}

function stopTimer() {
  clearInterval(timer);
  timer = null;
}

export function isCancelCommand(text) {
  return CANCEL_PATTERN.test(String(text || ''));
}

export function queueSend(action) {
  if (action?.type !== 'whatsapp_send') return;
  stopTimer();
  clearTimeout(clearTimer);
  const settings = getActionSettings();
  if (action.requiresManualConfirmation || settings.confirmEverySend) {
    setState({ action, status: 'confirm' });
    return;
  }
  if (!settings.undoSeconds) {
    void execute(false, action);
    return;
  }
  setState({ action, status: 'counting', secondsLeft: settings.undoSeconds });
  timer = setInterval(() => {
    if (state?.status !== 'counting') { stopTimer(); return; }
    const secondsLeft = state.secondsLeft - 1;
    if (secondsLeft <= 0) {
      stopTimer();
      void execute(false, state.action);
    } else {
      setState({ ...state, secondsLeft });
    }
  }, 1000);
}

/** Only from a tap on the confirm button. */
export function confirmPendingSend() {
  if (state?.status !== 'confirm') return;
  void execute(true, state.action);
}

/** Returns true when something was cancelled. */
export function cancelPendingSend() {
  if (state?.status !== 'counting' && state?.status !== 'confirm') return false;
  stopTimer();
  setState({ ...state, status: 'cancelled' });
  clearLater(2500);
  return true;
}

async function execute(manualConfirmation, action) {
  setState({ action, status: 'sending' });
  try {
    const token = await getAccessToken();
    if (!token) throw new Error('انتهت جلسة الدخول.');
    const response = await fetch('/api/whatsapp/cluster/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recipients: action.recipients, text: action.text, manualConfirmation }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && !data.sent) throw new Error(data.error || 'تعذر الإرسال.');
    const partial = data.failed > 0;
    setState({ action, status: partial ? 'failed' : 'sent', error: partial ? `أُرسلت إلى ${data.sent} وتعذرت إلى ${data.failed}.` : null });
    onResult({ ok: !partial, action, data });
  } catch (error) {
    setState({ action, status: 'failed', error: error?.message || 'تعذر الإرسال.' });
    onResult({ ok: false, action, error });
  }
  clearLater(5000);
}
