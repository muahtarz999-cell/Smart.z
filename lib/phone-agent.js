'use client';

/**
 * Controls other Android apps step by step (owner request 2026-10-22).
 * The loop runs natively inside the accessibility service (ScreenControlPlugin /
 * ScreenAgent.java) so it keeps going while the other app is in front; each step
 * asks /api/phone-agent/step what to do next on the current screen.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { getDeviceId } from './device-lock';

const ScreenControl = registerPlugin('ScreenControl');
let running = false;

export function isPhoneAgentRunning() {
  return running;
}

export function phoneControlAvailable() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function isScreenControlEnabled() {
  if (!phoneControlAvailable()) return false;
  try {
    const { enabled } = await ScreenControl.isEnabled();
    return enabled === true;
  } catch {
    return false;
  }
}

export async function openScreenControlSettings() {
  if (phoneControlAvailable()) await ScreenControl.openSettings();
}

/**
 * Starts the agent for { goal, appName }. getAccessToken returns the current Supabase token.
 * onProgress receives { status: running|done|stopped|failed|needs_user, say, step }.
 * Resolves to a message for the user when it could not start, else ''.
 */
export async function startPhoneAgent(action, { getAccessToken, onProgress } = {}) {
  if (action?.type !== 'phone_agent') return '';
  if (!phoneControlAvailable()) return 'التحكم في التطبيقات يعمل في تطبيق Smart.z على أندرويد فقط.';
  if (!(await isScreenControlEnabled())) {
    await openScreenControlSettings().catch(() => {});
    return 'فعّل «Smart.z — التحكم في التطبيقات» من إعدادات إمكانية الوصول ثم أعد الطلب.';
  }
  const token = await getAccessToken?.();
  if (!token) return 'انتهت جلسة الدخول.';

  await ScreenControl.removeAllListeners().catch(() => {});
  await ScreenControl.addListener('progress', (event) => {
    running = event?.status === 'running';
    onProgress?.(event || {});
  });
  running = true;
  await ScreenControl.start({
    goal: action.goal,
    appName: action.appName || '',
    baseUrl: window.location.origin,
    accessToken: token,
    deviceId: getDeviceId() || '',
  });
  return '';
}

export async function stopPhoneAgent() {
  running = false;
  if (phoneControlAvailable()) await ScreenControl.stop().catch(() => {});
}

/** Keeps the native loop's token fresh (Supabase sessions refresh hourly). */
export async function updatePhoneAgentToken(accessToken) {
  if (phoneControlAvailable() && accessToken) await ScreenControl.updateToken({ accessToken }).catch(() => {});
}
