'use client';

/**
 * «لخّص يومي» on the phone (owner request 2026-10-22). Runs only when the user
 * asks: gathers today's (or yesterday's) WhatsApp messages stored on this phone,
 * SMS and the call log (Android, after permission), the receptionist's calls and
 * the hidden promises due today, then asks /api/day-summary for one summary.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { callLines, periodRange, receptionistLines, smsLines, summaryPeriod } from './day-summary';
import { listInboxMessages, syncInbox } from './whatsapp-inbox-store';
import { dueCommitmentLines } from './commitments-store';
import { currentCoords, deviceTimeZone } from './location';

const CallAssistant = registerPlugin('CallAssistant');
const isAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

function whatsappLines(items, range) {
  return items
    .filter((item) => !item.outgoing && item.sentAt >= range.from && item.sentAt < range.to)
    .map((item) => {
      const who = item.senderName || (item.senderNumber ? `+${item.senderNumber}` : 'مرسل');
      return `${who}${item.isGroup && item.chatName ? ` (في ${item.chatName})` : ''}: ${String(item.text || '').replace(/\s+/g, ' ').slice(0, 400)}`;
    });
}

async function nativeLines(range, unavailable) {
  if (!isAndroid()) {
    unavailable.push('الرسائل النصية وسجل المكالمات (متاحة في تطبيق أندرويد فقط)');
    return { sms: [], calls: [] };
  }
  const status = await CallAssistant.requestSummaryPermissions().catch(() => ({}));
  const [sms, calls] = await Promise.all([
    status.smsPermission ? CallAssistant.getRecentSms(range).then((r) => smsLines(r.items)).catch(() => null) : null,
    status.callsPermission ? CallAssistant.getRecentCalls(range).then((r) => callLines(r.items)).catch(() => null) : null,
  ]);
  if (sms === null) unavailable.push('الرسائل النصية (لم يُمنح الإذن)');
  if (calls === null) unavailable.push('سجل المكالمات (لم يُمنح الإذن)');
  return { sms: sms || [], calls: calls || [] };
}

async function receptionist(token, range) {
  try {
    const response = await fetch('/api/receptionist/calls', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!response.ok) return [];
    const data = await response.json().catch(() => ({}));
    return receptionistLines(data.calls, range);
  } catch {
    return [];
  }
}

/** Returns the summary text (throws with a readable message when it fails). */
export async function summarizeDay(text, { getAccessToken, channel = 'text', responseStyle, language } = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('سجّل الدخول أولًا.');
  const period = summaryPeriod(text);
  const range = periodRange(period, Date.now(), new Date().getTimezoneOffset());
  const unavailable = [];

  const sync = await syncInbox(getAccessToken, { force: true }).catch(() => ({ linked: true, failed: true }));
  if (sync.waking || sync.failed) unavailable.push('بعض رسائل واتساب الأحدث (الخادم يستيقظ)');

  const [inbox, native, received, commitments, coords] = await Promise.all([
    listInboxMessages().catch(() => []),
    nativeLines(range, unavailable),
    receptionist(token, range),
    period === 'today' ? dueCommitmentLines(range.to + 6 * 60 * 60 * 1000).catch(() => []) : [],
    currentCoords().catch(() => null),
  ]);

  const response = await fetch('/api/day-summary', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      message: text,
      channel,
      responseStyle,
      language,
      timeZone: deviceTimeZone(),
      coords,
      context: {
        period,
        whatsapp: sync.linked === false ? [] : whatsappLines(inbox, range),
        sms: native.sms,
        calls: native.calls,
        receptionist: received,
        commitments,
        unavailable,
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.reply !== 'string' || !data.reply.trim()) {
    throw new Error(data.message || 'تعذّر إعداد الملخص الآن.');
  }
  return data.reply.trim();
}
