'use client';

/**
 * Precise location (owner request 2026-10-22), only when the user turns it on in
 * «ملفي». Coordinates are rounded to about 1 km and sent with assistant requests;
 * the server turns them into a city name and only the name reaches the model.
 * Without it, the server estimates the city from the connection.
 */

const SETTING_KEY = 'smartz-precise-location';
const MAX_AGE_MS = 30 * 60 * 1000;
let cached = null; // { coords, at }

export function preciseLocationEnabled() {
  try {
    return localStorage.getItem(SETTING_KEY) === '1';
  } catch {
    return false;
  }
}

function readPosition(options) {
  return new Promise((resolve, reject) => {
    if (!globalThis.navigator?.geolocation) {
      reject(new Error('الجهاز لا يوفّر الموقع.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

/** Turns precise location on (asks the system permission once) or off. */
export async function setPreciseLocation(enabled) {
  if (!enabled) {
    try { localStorage.removeItem(SETTING_KEY); } catch {}
    cached = null;
    return false;
  }
  await readPosition({ enableHighAccuracy: false, timeout: 15_000, maximumAge: MAX_AGE_MS });
  try { localStorage.setItem(SETTING_KEY, '1'); } catch {}
  cached = null;
  return true;
}

/** Rounded coordinates when enabled, else null. Never blocks a request for long. */
export async function currentCoords() {
  if (!preciseLocationEnabled()) return null;
  if (cached && Date.now() - cached.at < MAX_AGE_MS) return cached.coords;
  try {
    const position = await readPosition({ enableHighAccuracy: false, timeout: 4_000, maximumAge: MAX_AGE_MS });
    const coords = {
      lat: Math.round(position.coords.latitude * 100) / 100,
      lon: Math.round(position.coords.longitude * 100) / 100,
    };
    cached = { coords, at: Date.now() };
    return coords;
  } catch {
    return cached?.coords || null; // permission withdrawn or no fix: the server estimates instead
  }
}

export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Riyadh';
  } catch {
    return 'Asia/Riyadh';
  }
}
