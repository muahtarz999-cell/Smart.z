'use client';

/**
 * Executes a phone system action the assistant planned (lib/assistant-tools.js → planPhoneAction).
 * Android: the SystemActions native plugin (android/.../SystemActionsPlugin.java).
 * iPhone / browser: standard links (tel:, sms:, maps, https) where they exist.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

const SystemActions = registerPlugin('SystemActions');

const isAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
const isIos = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

function openLink(url) {
  if (Capacitor.isNativePlatform()) {
    window.location.href = url; // the WebView hands tel:/sms:/maps to the system
    return;
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.href = url;
}

const digitsOnly = (value) => String(value || '').replace(/[^\d+]/g, '');
const looksLikeNumber = (value) => /^\+?\d{6,15}$/.test(digitsOnly(value));

function mapsUrl(destination) {
  const query = encodeURIComponent(destination);
  return isIos() ? `maps://?q=${query}` : `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/** Runs the action. Resolves to a message to show when something needs the user, else ''. */
export async function executeDeviceAction(action) {
  if (action?.type !== 'device_action') return '';

  if (isAndroid()) {
    // The native side reads times as epoch milliseconds (no java.time on Android 7).
    const times = action.action === 'calendar_event'
      ? { startMillis: Date.parse(action.start), endMillis: Date.parse(action.end) }
      : {};
    const result = await SystemActions.perform({ ...action, ...times });
    return typeof result?.message === 'string' ? result.message : '';
  }

  switch (action.action) {
    case 'call':
      if (!looksLikeNumber(action.recipient)) return 'الاتصال بالاسم يحتاج تطبيق أندرويد؛ قل الرقم.';
      openLink(`tel:${digitsOnly(action.recipient)}`);
      return '';
    case 'sms': {
      if (!looksLikeNumber(action.recipient)) return 'الرسالة بالاسم تحتاج تطبيق أندرويد؛ قل الرقم.';
      const separator = isIos() ? '&' : '?';
      openLink(`sms:${digitsOnly(action.recipient)}${action.message ? `${separator}body=${encodeURIComponent(action.message)}` : ''}`);
      return '';
    }
    case 'navigate':
      openLink(mapsUrl(action.destination));
      return '';
    case 'open_url':
      openLink(action.url);
      return '';
    case 'web_search':
      openLink(`https://www.google.com/search?q=${encodeURIComponent(action.query)}`);
      return '';
    default:
      return 'هذا الإجراء يعمل في تطبيق Smart.z على أندرويد.';
  }
}

/** Whether this install can run phone actions (Android fully; others partly through links). */
export function phoneActionsAvailable() {
  return typeof window !== 'undefined';
}
