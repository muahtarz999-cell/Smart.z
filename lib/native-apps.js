'use client';

import { AppLauncher } from '@capacitor/app-launcher';
import { Capacitor } from '@capacitor/core';

const EXTERNAL_APPS = Object.freeze({
  whatsapp: {
    android: 'com.whatsapp',
    ios: 'whatsapp://',
    web: 'https://wa.me/',
  },
  x: {
    android: 'com.twitter.android',
    ios: 'twitter://timeline',
    web: 'https://x.com/',
  },
});

async function openExternalUrl(url) {
  const destination = new URL(url);
  if (!['wa.me', 'x.com', 'twitter.com'].includes(destination.hostname)) {
    throw new TypeError('Unsupported external destination.');
  }

  if (Capacitor.isNativePlatform()) {
    await AppLauncher.openUrl({ url: destination.toString() });
    return;
  }

  const openedWindow = window.open(destination.toString(), '_blank', 'noopener,noreferrer');
  if (!openedWindow) throw new Error('تعذر فتح التطبيق الخارجي. اسمح بالنوافذ المنبثقة ثم حاول مجددًا.');
}

export async function openInstalledApp(appId) {
  const app = EXTERNAL_APPS[appId];
  if (!app) throw new TypeError('Unsupported external application.');

  if (!Capacitor.isNativePlatform()) {
    return openExternalUrl(app.web);
  }

  const platform = Capacitor.getPlatform();
  const nativeUrl = platform === 'ios' ? app.ios : app.android;
  const { value: canOpen } = await AppLauncher.canOpenUrl({ url: nativeUrl });
  if (canOpen) {
    await AppLauncher.openUrl({ url: nativeUrl });
    return;
  }
  await openExternalUrl(app.web);
}

export async function openWhatsAppChat(phoneNumber, message) {
  const phone = String(phoneNumber || '').replace(/\D/g, '');
  if (!/^\d{9,15}$/.test(phone)) {
    throw new TypeError('أدخل رقمًا صحيحًا مع رمز الدولة، من 9 إلى 15 رقمًا.');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new TypeError('اكتب نص الرسالة قبل فتح WhatsApp.');
  }
  if ([...message].length > 4096) {
    throw new TypeError('نص رسالة WhatsApp أطول من الحد المسموح.');
  }

  const url = new URL(`https://wa.me/${phone}`);
  url.searchParams.set('text', message.trim());
  await openExternalUrl(url.toString());
}

export async function openTweetComposer(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new TypeError('اكتب نص التغريدة قبل فتح X.');
  }
  if ([...text].length > 280) {
    throw new TypeError('يجب ألا يتجاوز نص التغريدة 280 حرفًا.');
  }

  const url = new URL('https://twitter.com/intent/tweet');
  url.searchParams.set('text', text.trim());
  await openExternalUrl(url.toString());
}
