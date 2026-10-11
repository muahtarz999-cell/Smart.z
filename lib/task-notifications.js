'use client';

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

const TASK_REMINDER_CHANNEL_ID = 'task-reminders';
const TASK_REMINDER_CHANNEL = {
  id: TASK_REMINDER_CHANNEL_ID,
  name: 'تذكيرات المهام',
  description: 'تنبيهات محلية لمواعيد المهام التي تختارها.',
  importance: 4,
  vibration: true,
};

export function areTaskRemindersSupported() {
  return Capacitor.isNativePlatform();
}

function getTaskNotificationId(taskId) {
  let hash = 2166136261;
  for (const character of String(taskId)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return (hash >>> 1) || 1;
}

function makeTaskNotification(task) {
  return {
    id: getTaskNotificationId(task.id),
    title: task.title,
    body: task.details || 'حان موعد المهمة التي حددتها.',
    schedule: {
      at: new Date(task.reminderAt),
      allowWhileIdle: true,
    },
    channelId: TASK_REMINDER_CHANNEL_ID,
    isExactNotification: false,
    extra: { kind: 'task-reminder', taskId: task.id },
  };
}

async function ensureTaskReminderChannel() {
  if (Capacitor.getPlatform() !== 'android') return { enabled: true };

  await LocalNotifications.createChannel(TASK_REMINDER_CHANNEL);
  const { channels } = await LocalNotifications.listChannels();
  const channel = channels.find(({ id }) => id === TASK_REMINDER_CHANNEL_ID);
  return {
    enabled: !channel || channel.importance !== 0,
    channel,
  };
}

export async function getTaskReminderStatus() {
  if (!areTaskRemindersSupported()) {
    return { supported: false, permission: 'unavailable', channelEnabled: false };
  }

  const { display } = await LocalNotifications.checkPermissions();
  const channelState = display === 'granted'
    ? await ensureTaskReminderChannel()
    : { enabled: true };

  return {
    supported: true,
    permission: display,
    channelEnabled: channelState.enabled,
  };
}

export async function requestTaskReminderPermission() {
  if (!areTaskRemindersSupported()) {
    return { supported: false, permission: 'unavailable', channelEnabled: false };
  }

  const currentStatus = await getTaskReminderStatus();
  if (currentStatus.permission === 'granted' || currentStatus.permission === 'denied') {
    return currentStatus;
  }

  const { display } = await LocalNotifications.requestPermissions();
  const channelState = display === 'granted'
    ? await ensureTaskReminderChannel()
    : { enabled: true };

  return {
    supported: true,
    permission: display,
    channelEnabled: channelState.enabled,
  };
}

export async function scheduleTaskReminder(task) {
  if (!task?.reminderAt || task.completed || new Date(task.reminderAt).getTime() <= Date.now()) {
    return false;
  }

  const status = await getTaskReminderStatus();
  if (!status.supported || status.permission !== 'granted' || !status.channelEnabled) {
    return false;
  }

  const notification = makeTaskNotification(task);
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.some(({ id }) => id === notification.id)) {
    await LocalNotifications.update({ notifications: [notification] });
  } else {
    await LocalNotifications.schedule({ notifications: [notification] });
  }
  return true;
}

export async function cancelTaskReminder(task) {
  if (!task?.id || !areTaskRemindersSupported()) return;
  const id = getTaskNotificationId(task.id);
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.some((notification) => notification.id === id)) {
    await LocalNotifications.cancel({ notifications: [{ id }] });
  }
}

export async function synchronizeTaskReminders(tasks) {
  if (!areTaskRemindersSupported()) return;
  const status = await getTaskReminderStatus();
  if (status.permission !== 'granted' || !status.channelEnabled) return;

  const pending = await LocalNotifications.getPending();
  const pendingTaskReminders = pending.notifications.filter(({ extra }) => (
    extra?.kind === 'task-reminder'
  ));
  const now = Date.now();
  const activeTasks = (tasks || []).filter((task) => (
    !task.completed
    && task.reminderAt
    && new Date(task.reminderAt).getTime() > now
  ));
  const activeIds = new Set(activeTasks.map(({ id }) => getTaskNotificationId(id)));
  const obsolete = pendingTaskReminders
    .filter(({ id }) => !activeIds.has(id))
    .map(({ id }) => ({ id }));

  if (obsolete.length) {
    await LocalNotifications.cancel({ notifications: obsolete });
  }

  const pendingIds = new Set(pendingTaskReminders.map(({ id }) => id));
  const toUpdate = [];
  const toSchedule = [];
  for (const task of activeTasks) {
    const notification = makeTaskNotification(task);
    (pendingIds.has(notification.id) ? toUpdate : toSchedule).push(notification);
  }
  if (toUpdate.length) {
    await LocalNotifications.update({ notifications: toUpdate });
  }
  if (toSchedule.length) {
    await LocalNotifications.schedule({ notifications: toSchedule });
  }
}
