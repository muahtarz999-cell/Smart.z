'use client';

/** Web side of the Android call assistant (android/.../calls/CallAssistantPlugin.java). */
import { Capacitor, registerPlugin } from '@capacitor/core';

const CallAssistant = registerPlugin('CallAssistant');

export function callAssistantAvailable() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

const EMPTY = { enabled: false, message: '', callsPermission: false, contactsPermission: false };

export async function getCallAssistantStatus() {
  if (!callAssistantAvailable()) return EMPTY;
  try {
    return { ...EMPTY, ...(await CallAssistant.getStatus()) };
  } catch {
    return EMPTY;
  }
}

/** Turning it on asks for the phone permissions first. */
export async function setCallAssistantEnabled(enabled) {
  if (!callAssistantAvailable()) return EMPTY;
  if (enabled) await CallAssistant.requestCallPermissions().catch(() => {});
  return { ...EMPTY, ...(await CallAssistant.setSettings({ enabled })) };
}

export async function setCallAssistantMessage(message) {
  if (!callAssistantAvailable()) return EMPTY;
  return { ...EMPTY, ...(await CallAssistant.setSettings({ message: String(message || '').slice(0, 300) })) };
}

export async function requestCallAssistantPermissions() {
  if (!callAssistantAvailable()) return EMPTY;
  return { ...EMPTY, ...(await CallAssistant.requestCallPermissions()) };
}

/**
 * Driving mode marks itself on the server so WhatsApp calls are rejected with
 * the driving message while it runs (expires by itself after 4 hours).
 */
export async function markDriving(active, getAccessToken) {
  try {
    const token = await getAccessToken();
    if (!token) return;
    await fetch('/api/whatsapp/cluster/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ driving: active === true }),
      cache: 'no-store',
    });
  } catch {
    // WhatsApp not linked or offline: phone calls still follow driving mode on the device.
  }
}
