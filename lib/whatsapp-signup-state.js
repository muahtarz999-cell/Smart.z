const phases = new Set(['idle', 'starting', 'awaiting-meta', 'saving']);
let signupState = { phase: 'idle', changedAt: 0 };

export function setWhatsAppSignupPhase(phase) {
  if (!phases.has(phase)) {
    throw new TypeError('Invalid WhatsApp signup phase');
  }

  signupState = { phase, changedAt: Date.now() };
  return { ...signupState };
}

export function getWhatsAppSignupState() {
  return { ...signupState };
}

export function clearWhatsAppSignupState() {
  signupState = { phase: 'idle', changedAt: Date.now() };
}
