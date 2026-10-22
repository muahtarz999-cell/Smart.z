/**
 * What the assistant knows about "now" and "here" (owner request 2026-10-22):
 * the Gregorian and Hijri date, the weekday and time in the user's time zone,
 * and the user's city — approximate from the connection, or precise from the
 * phone's GPS when the user turned that on. Only a city name reaches the model.
 */

const DEFAULT_TIME_ZONE = 'Asia/Riyadh';

export function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function part(parts, type) {
  return parts.find((item) => item.type === type)?.value || '';
}

/** { gregorian: '2026-10-22', weekday, time: '15:00', hijri, timeZone } in the user's zone. */
export function describeNow(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const zone = validTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const gregorian = `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`;
  const time = `${part(parts, 'hour')}:${part(parts, 'minute')}`;
  const weekday = new Intl.DateTimeFormat('ar', { timeZone: zone, weekday: 'long' }).format(now);
  let hijri = '';
  try {
    hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', {
      timeZone: zone, year: 'numeric', month: 'long', day: 'numeric',
    }).format(now);
  } catch {
    hijri = '';
  }
  return { gregorian, weekday, time, hijri, timeZone: zone };
}

/** One line for the model: never guess the date or time again. */
export function timeInstruction(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const { gregorian, weekday, time, hijri, timeZone: zone } = describeNow(now, timeZone);
  return `التاريخ والوقت الآن عند المستخدم: ${gregorian} (${weekday})، الساعة ${time} بتوقيت ${zone}${hijri ? `، ويوافق ${hijri}` : ''}. اعتمد على هذا عند أي سؤال عن الوقت أو التاريخ أو الأيام، ولا تقدّر من عندك.`;
}

// ---------------------------------------------------------------- location

const clip = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f<>]+/g, ' ').trim().slice(0, max) : '');

/** { city, region, country, source: 'gps' | 'network' } with names only, or null. */
export function sanitizeLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const location = {
    city: clip(value.city, 80),
    region: clip(value.region, 80),
    country: clip(value.country, 80),
    source: value.source === 'gps' ? 'gps' : 'network',
  };
  return location.city || location.region || location.country ? location : null;
}

export function locationInstruction(location) {
  const clean = sanitizeLocation(location);
  if (!clean) return 'موقع المستخدم غير معروف؛ إذا احتاج الجواب مدينته فاسأله عنها.';
  const place = [clean.city, clean.region, clean.country].filter(Boolean).join('، ');
  return clean.source === 'gps'
    ? `المستخدم الآن في: ${place} (من موقع جهازه).`
    : `موقع المستخدم التقريبي: ${place} (تقدير من اتصاله بالإنترنت وقد يكون مدينة قريبة؛ إن كان مهمًا للجواب فتأكد منه).`;
}

/** Coordinates rounded to ~1 km; anything else is ignored. */
export function sanitizeCoords(value) {
  const lat = Number(value?.lat);
  const lon = Number(value?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

const COUNTRY_NAMES = { SA: 'السعودية', AE: 'الإمارات', KW: 'الكويت', QA: 'قطر', BH: 'البحرين', OM: 'عُمان', EG: 'مصر', JO: 'الأردن' };

/** Approximate location from Cloudflare (headers, or the request's cf object). */
export function networkLocation(headers, cf = null) {
  const get = (name) => {
    try {
      const value = headers?.get?.(name);
      return value ? decodeURIComponent(value) : '';
    } catch {
      return '';
    }
  };
  const countryCode = String(cf?.country || get('cf-ipcountry') || '').toUpperCase();
  return sanitizeLocation({
    city: cf?.city || get('cf-ipcity'),
    region: cf?.region || get('cf-region'),
    country: COUNTRY_NAMES[countryCode] || (countryCode && countryCode !== 'XX' ? countryCode : ''),
    source: 'network',
  });
}

const geocodeCache = new Map(); // "lat,lon" → location (per worker instance)

/** GPS → city name (OpenStreetMap Nominatim, Arabic names). Cached; null on failure. */
export async function reverseGeocode(coords, fetchImpl = globalThis.fetch) {
  const clean = sanitizeCoords(coords);
  if (!clean) return null;
  const key = `${clean.lat},${clean.lon}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(clean.lat));
    url.searchParams.set('lon', String(clean.lon));
    url.searchParams.set('zoom', '10');
    url.searchParams.set('accept-language', 'ar');
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'Smart.z assistant (city lookup)', Accept: 'application/json' },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const address = data?.address || {};
    const location = sanitizeLocation({
      city: address.city || address.town || address.village || address.county || '',
      region: address.state || address.region || '',
      country: address.country || '',
      source: 'gps',
    });
    if (geocodeCache.size > 500) geocodeCache.clear();
    geocodeCache.set(key, location);
    return location;
  } catch {
    return null;
  }
}

/** Server side: GPS city when the app sent coordinates, else the network estimate. */
export async function resolveUserLocation(request, coords) {
  const fromGps = coords ? await reverseGeocode(coords) : null;
  if (fromGps) return fromGps;
  let cf = request?.cf || null;
  if (!cf) {
    try {
      const { getCloudflareContext } = await import('@opennextjs/cloudflare');
      cf = getCloudflareContext()?.cf || null;
    } catch {
      cf = null; // local development: no Cloudflare context
    }
  }
  return networkLocation(request?.headers, cf);
}
