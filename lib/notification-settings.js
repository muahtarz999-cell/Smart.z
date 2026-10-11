'use client';

import { AppLauncher } from '@capacitor/app-launcher';
import { Capacitor, registerPlugin } from '@capacitor/core';

const NotificationSettings = registerPlugin('NotificationSettings');

export async function openNotificationSettings() {
  if (Capacitor.getPlatform() === 'android') {
    await NotificationSettings.open();
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
