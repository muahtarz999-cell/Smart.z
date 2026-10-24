// Guesses which side of computer pairing the current device plays.
// 'phone'    → should scan the QR code (/computer/approve)
// 'computer' → should display the QR code (/computer/pair)
export function detectPairingRole(win = globalThis.window) {
  if (!win) return 'computer';
  const platform = win.Capacitor?.getPlatform?.();
  if (platform === 'android' || platform === 'ios') return 'phone';

  const nav = win.navigator || {};
  if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean') {
    return nav.userAgentData.mobile ? 'phone' : 'computer';
  }
  const ua = String(nav.userAgent || '');
  if (/Android|iPhone|iPod|iPad|Mobile|Windows Phone/i.test(ua)) return 'phone';
  // iPadOS reports itself as Macintosh but has touch points.
  if (/Macintosh/i.test(ua) && Number(nav.maxTouchPoints) > 1) return 'phone';
  return 'computer';
}
