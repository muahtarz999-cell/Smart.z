'use client';

import { AppLauncher } from '@capacitor/app-launcher';
import { Capacitor, registerPlugin } from '@capacitor/core';

let notificationSettingsPlugin = null;

function getNotificationSettingsPlugin() {
  if (typeof window === 'undefined' || !window.Capacitor) {
    throw new Error('إعدادات الإشعارات متاحة داخل تطبيق Capacitor فقط.');
  }
  if (!notificationSettingsPlugin) {
    notificationSettingsPlugin = registerPlugin('NotificationSettings');
  }
  return notificationSettingsPlugin;
}

export async function openNotificationSettings() {
  if (Capacitor.getPlatform() === 'android') {
    await getNotificationSettingsPlugin().open();
    return;
  }

  if (Capacitor.getPlatform() === 'ios') {
    const result = await AppLauncher.openUrl({ url: 'app-settings:' });
    if (!result.completed) {
      throw new Error('تعذر فتح إعدادات الإشعارات. افتح إعدادات الجهاز ثم إعدادات Smart.z.');
    }
    return;
  }

  throw new Error('افتح إعدادات Smart.z من إعدادات الجهاز لإدارة الإشعارات.');
}
